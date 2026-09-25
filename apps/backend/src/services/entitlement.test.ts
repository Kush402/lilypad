import { describe, it, expect } from 'vitest';
import { hostedAskAccessFor, remoteAccessFor } from './entitlement.js';
import { entitlesHostedAsk } from './subscription.js';
import { users } from '../db/schema.js';

/**
 * Enough of Drizzle's chain to answer the account lookup and the subscription
 * lookup -- which are two different tables, so the fake dispatches on the one
 * it is handed. Returning the account row to both queries is what let an
 * earlier version of this fake build a nonsense subscription out of `{tier}`
 * and still pass.
 */
function fakeDb(
  accounts: { tier: string; isBillingTester?: boolean; tierExpiresAt?: Date | null }[],
  subscriptionRows: unknown[] = [],
) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === users ? accounts : subscriptionRows;
        return {
          where: () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) }),
        };
      },
    }),
  } as never;
}

/**
 * `users.tier` was declared in M8 and read by nothing for eight milestones.
 * ADR-0016 makes it load-bearing: it is the one thing a subscription buys.
 */
describe('who may reach a laptop from another network', () => {
  it('lets a paying account through', async () => {
    expect(await remoteAccessFor('u', fakeDb([{ tier: 'pro' }]))).toBe('entitled');
    expect(await remoteAccessFor('u', fakeDb([{ tier: 'team' }]))).toBe('entitled');
  });

  it('holds the free tier to its own network', async () => {
    expect(await remoteAccessFor('u', fakeDb([{ tier: 'free' }]))).toBe('not_entitled');
  });

  it('stops a time-limited Pro grant at its deadline without a cleanup event', async () => {
    const now = Date.parse('2026-09-24T00:00:00Z');
    const db = fakeDb([{ tier: 'pro', tierExpiresAt: new Date(now) }]);
    expect(await remoteAccessFor('u', db, now - 1)).toBe('entitled');
    expect(await remoteAccessFor('u', db, now)).toBe('not_entitled');
    expect(await hostedAskAccessFor('u', db, now - 1)).toBe('entitled');
    expect(await hostedAskAccessFor('u', db, now)).toBe('not_entitled');
  });

  it('is decided by the subscription, not only by the manual tier', async () => {
    // The comment in `entitlement.ts` claims an expired subscription stops
    // entitling here too, notification or not. Nothing tested it: the fake
    // never returned a subscription row at all.
    const day = 24 * 60 * 60 * 1000;
    const now = Date.parse('2026-09-15T00:00:00Z');
    const subscription = (expiresAt: number, status = 'active') => [
      {
        environment: 'Sandbox',
        originalTransactionId: 'orig-1',
        ownerUserId: 'u',
        productId: 'com.takedia.lilypad.pro.monthly',
        status,
        expiresAt: new Date(expiresAt),
        graceExpiresAt: null,
        lastTransactionId: 'tx-1',
        lastPurchaseDate: new Date(now - day),
        revokedAt: null,
      },
    ];

    // The test environment is Sandbox, so a Sandbox subscription is the
    // commercial one here and entitles a free-tier account.
    expect(
      await remoteAccessFor('u', fakeDb([{ tier: 'free' }], subscription(now + day)), now),
    ).toBe('entitled');
    // Same row, period passed, no EXPIRED notification ever delivered.
    expect(
      await remoteAccessFor('u', fakeDb([{ tier: 'free' }], subscription(now - day)), now),
    ).toBe('not_entitled');
    // A refund ends it regardless of the period still running.
    expect(
      await remoteAccessFor(
        'u',
        fakeDb([{ tier: 'free' }], subscription(now + day, 'revoked')),
        now,
      ),
    ).toBe('not_entitled');
  });

  it('does not tell a deleted account to upgrade', async () => {
    // "Subscribe to continue" is advice that cannot be followed when there is
    // no account to subscribe. The two answers are kept apart so a caller
    // cannot accidentally give one for the other.
    expect(await remoteAccessFor('gone', fakeDb([]))).toBe('no_such_account');
  });

  it('refuses a tier it does not recognise, rather than assuming the best', async () => {
    // A tier added to the enum and not to REMOTE_TIERS should fail closed. The
    // opposite default hands out the paid feature on a typo.
    expect(await remoteAccessFor('u', fakeDb([{ tier: 'enterprise-trial' }]))).toBe('not_entitled');
  });
});

/**
 * Ask on Lilypad's own System One account (ADR-0020).
 *
 * The same evaluator as above, asked a different question — so every rule
 * about periods, refunds and environments has to hold here too. These are
 * separate tests rather than a loop over both functions on purpose: if the
 * two ever stop agreeing, that must be a deliberate change with its own
 * failing assertion, not a silent one.
 */
describe('who may run a task on Lilypad’s own account', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-09-19T12:00:00Z');
  const subscription = (
    expiresAt: number,
    status = 'active',
    environment: 'Sandbox' | 'Production' = 'Sandbox',
  ) => [
    {
      environment,
      originalTransactionId: 'orig-1',
      ownerUserId: 'u',
      productId: 'com.takedia.lilypad.pro.monthly',
      status,
      expiresAt: new Date(expiresAt),
      graceExpiresAt: null,
      lastTransactionId: 'tx-1',
      lastPurchaseDate: new Date(now - day),
      revokedAt: null,
    },
  ];

  it('refuses the free tier', async () => {
    expect(await hostedAskAccessFor('u', fakeDb([{ tier: 'free' }]), now)).toBe('not_entitled');
  });

  it('admits Pro and Team', async () => {
    expect(await hostedAskAccessFor('u', fakeDb([{ tier: 'pro' }]), now)).toBe('entitled');
    expect(await hostedAskAccessFor('u', fakeDb([{ tier: 'team' }]), now)).toBe('entitled');
  });

  it('admits a current Apple subscription on an otherwise free account', async () => {
    expect(
      await hostedAskAccessFor('u', fakeDb([{ tier: 'free' }], subscription(now + day)), now),
    ).toBe('entitled');
  });

  it('refuses a subscription whose period has passed, notification or not', async () => {
    // L-294: entitlement is a question about the clock, never a stored word.
    // A missed EXPIRED notification must not buy a free data plane.
    expect(
      await hostedAskAccessFor('u', fakeDb([{ tier: 'free' }], subscription(now - day)), now),
    ).toBe('not_entitled');
  });

  it('refuses a revoked or refunded subscription still inside its period', async () => {
    expect(
      await hostedAskAccessFor(
        'u',
        fakeDb([{ tier: 'free' }], subscription(now + day, 'revoked')),
        now,
      ),
    ).toBe('not_entitled');
  });

  it('refuses an expired status even with a future period end', async () => {
    expect(
      await hostedAskAccessFor(
        'u',
        fakeDb([{ tier: 'free' }], subscription(now + day, 'expired')),
        now,
      ),
    ).toBe('not_entitled');
  });

  it('does not let an expired commercial row hide a current tester subscription', async () => {
    // The test deployment sells in Sandbox. Production is the other
    // environment here; on the live service these two labels are reversed.
    // The selection rule must be symmetric, and only an approved tester may
    // use the current row from the other environment.
    const expiredSandbox = subscription(now - day)[0]!;
    const currentProduction = {
      ...subscription(now + day, 'active', 'Production')[0]!,
      originalTransactionId: 'orig-2',
    };
    const rows = [expiredSandbox, currentProduction];
    expect(
      await hostedAskAccessFor('u', fakeDb([{ tier: 'free', isBillingTester: true }], rows), now),
    ).toBe('entitled');
    expect(await hostedAskAccessFor('u', fakeDb([{ tier: 'free' }], rows), now)).toBe(
      'not_entitled',
    );
  });

  it('fails closed on an account that no longer exists', async () => {
    expect(await hostedAskAccessFor('gone', fakeDb([]), now)).toBe('no_such_account');
  });

  it('refuses a tier nobody added to the paid set', async () => {
    expect(await hostedAskAccessFor('u', fakeDb([{ tier: 'enterprise-trial' }]), now)).toBe(
      'not_entitled',
    );
  });
});

/**
 * The environment rule (L-298), asked of the pure evaluator.
 *
 * `hostedAskAccessFor` reads `APPLE_IAP_ENVIRONMENT` from the process config,
 * which is Sandbox under test — so the one case that matters commercially, a
 * TestFlight purchase against a Production deployment, can only be stated
 * here. It is stated, because "someone bought it in the sandbox" is the
 * cheapest way to get a free data plane if nobody checks.
 */
describe('a test purchase does not buy Lilypad’s account', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const sandboxSubscription = {
    environment: 'Sandbox' as const,
    originalTransactionId: 'orig-1',
    ownerUserId: 'u',
    productId: 'com.takedia.lilypad.pro.monthly',
    status: 'active' as const,
    expiresAt: now + 24 * 60 * 60 * 1000,
    graceExpiresAt: null,
    lastTransactionId: 'tx-1',
    lastPurchaseDate: now - 24 * 60 * 60 * 1000,
    revokedAt: null,
  };

  it('refuses a Sandbox subscription on a Production deployment', () => {
    expect(
      entitlesHostedAsk({
        manualTier: 'free',
        subscription: sandboxSubscription,
        commercialEnvironment: 'Production',
        now,
      }),
    ).toBe(false);
  });

  it('admits it for an approved tester, and only for them', () => {
    expect(
      entitlesHostedAsk({
        manualTier: 'free',
        subscription: sandboxSubscription,
        commercialEnvironment: 'Production',
        isApprovedTester: true,
        now,
      }),
    ).toBe(true);
  });
});

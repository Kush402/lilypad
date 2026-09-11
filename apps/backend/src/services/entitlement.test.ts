import { describe, it, expect } from 'vitest';
import { remoteAccessFor } from './entitlement.js';
import { users } from '../db/schema.js';

/**
 * Enough of Drizzle's chain to answer the account lookup and the subscription
 * lookup -- which are two different tables, so the fake dispatches on the one
 * it is handed. Returning the account row to both queries is what let an
 * earlier version of this fake build a nonsense subscription out of `{tier}`
 * and still pass.
 */
function fakeDb(accounts: { tier: string }[], subscriptionRows: unknown[] = []) {
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

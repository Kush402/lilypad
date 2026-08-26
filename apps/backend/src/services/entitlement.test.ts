import { describe, it, expect } from 'vitest';
import { remoteAccessFor } from './entitlement.js';

/** Enough of Drizzle's chain to answer one `select ... where ... limit`. */
function fakeDb(rows: { tier: string }[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
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

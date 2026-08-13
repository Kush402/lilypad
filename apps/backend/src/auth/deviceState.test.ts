import { describe, it, expect } from 'vitest';
import { deviceState, isLinked } from './deviceState.js';

const KEY = 'a'.repeat(43);

describe('deviceState', () => {
  it('is unlinked when no account owns it, even holding a keypair', () => {
    // The desktop's first run: it generates a keypair immediately, long before
    // any account approves it. Calling that "linked" IS the account-equals-
    // discovery mistake the product model exists to prevent.
    expect(deviceState({ userId: null, publicKey: KEY, revokedAt: null })).toBe('unlinked');
  });

  it('is unlinked when an account owns it but it holds no key', () => {
    // A pre-accounts row adopted by a backfill, or a device that never
    // enrolled. It cannot prove it is itself, so it cannot act.
    expect(deviceState({ userId: 'user-1', publicKey: null, revokedAt: null })).toBe('unlinked');
  });

  it('is linked only when an account owns it AND it can prove its identity', () => {
    expect(deviceState({ userId: 'user-1', publicKey: KEY, revokedAt: null })).toBe('linked');
  });

  it('is revoked regardless of owner and key — revocation outranks both', () => {
    expect(deviceState({ userId: 'user-1', publicKey: KEY, revokedAt: new Date() })).toBe(
      'revoked',
    );
  });

  it('reports a revoked device as revoked even if its owner was cleared', () => {
    expect(deviceState({ userId: null, publicKey: null, revokedAt: new Date() })).toBe('revoked');
  });

  it('isLinked is true for exactly the linked state', () => {
    expect(isLinked({ userId: 'u', publicKey: KEY, revokedAt: null })).toBe(true);
    expect(isLinked({ userId: null, publicKey: KEY, revokedAt: null })).toBe(false);
    expect(isLinked({ userId: 'u', publicKey: KEY, revokedAt: new Date() })).toBe(false);
  });
});

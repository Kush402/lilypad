import { vi, describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, verifyAgainstDummy } from './password.js';

/**
 * scrypt is the point of this file, and it is deliberately expensive: 32 MiB
 * and ~350 ms per hash on an unloaded machine (`auth/password.ts`). Several
 * tests here hash three or four times, so vitest's 5-second default is only
 * ~3x headroom — and a two-core CI runner sharing itself with the rest of the
 * suite eats that easily. These timed out under load while passing in
 * isolation, which is the signature of a flaky test rather than a slow one.
 * The work is real and must stay; the deadline is what was wrong.
 */
vi.setConfig({ testTimeout: 30_000 });

describe('password hashing', () => {
  it('verifies the password it hashed', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery staple', b)).toBe(true);
  });

  it('carries its parameters, so a future cost change leaves old rows verifiable', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.split('$').slice(0, 4)).toEqual(['scrypt', '32768', '8', '1']);
  });

  /**
   * NIST SP 800-63B §5.1.1.2. "é" typed as one code point and as e + U+0301 are
   * different byte strings; without NFKC the user who set their password on one
   * keyboard cannot sign in from the other, and the failure is unexplainable.
   */
  it('normalizes, so the same characters verify however they were composed', async () => {
    const composed = 'café passphrase!';
    const precomposed = 'café passphrase!';
    expect(composed).not.toBe(precomposed);
    expect(await verifyPassword(composed, await hashPassword(precomposed))).toBe(true);
  });

  it('returns false — never throws — for a malformed stored value', async () => {
    for (const bad of [
      '',
      'not-a-hash',
      'scrypt$32768$8$1$onlyfivefields',
      'bcrypt$32768$8$1$c2FsdA$aGFzaA',
      'scrypt$0$8$1$c2FsdA$aGFzaA',
      'scrypt$32768$8$1$$aGFzaA',
      'scrypt$99999999$8$1$c2FsdA$aGFzaA',
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  /** The no-account branch must cost what a real check costs, or its speed is
   * an account-existence oracle on the sign-in route. */
  it('the dummy verification always fails and does real work', async () => {
    const started = process.hrtime.bigint();
    expect(await verifyAgainstDummy('anything at all')).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeGreaterThan(5);
  });
});

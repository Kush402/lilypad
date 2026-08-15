import { describe, it, expect } from 'vitest';
import { redisKeys } from '@lilypad/shared';
import {
  createMagicLink,
  redeemMagicLink,
  createPasswordReset,
  redeemPasswordReset,
  MAGIC_LINK_TTL_SECONDS,
  type MagicLinkRedis,
} from './magicLink.js';

/** Fake Redis modelling the one behaviour that matters: `getdel` is atomic, so
 * a second read of the same key finds nothing. */
function fakeRedis(): MagicLinkRedis & { store: Map<string, { value: string; ttl: number }> } {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    set(key, value, _mode, ttlSeconds) {
      store.set(key, { value, ttl: ttlSeconds });
      return Promise.resolve('OK');
    },
    getdel(key) {
      const entry = store.get(key);
      store.delete(key);
      return Promise.resolve(entry?.value ?? null);
    },
  };
}

describe('magic link', () => {
  it('stores the address under a single-use token with a TTL', async () => {
    const redis = fakeRedis();
    const { token, expiresInSeconds } = await createMagicLink('ada@example.com', redis);
    const entry = redis.store.get(redisKeys.magicLink(token));
    expect(entry?.value).toBe('ada@example.com');
    expect(entry?.ttl).toBe(expiresInSeconds);
  });

  it('normalizes the address it proves', async () => {
    const redis = fakeRedis();
    const { token } = await createMagicLink('  Ada@Example.COM ', redis);
    expect(await redeemMagicLink(token, redis)).toBe('ada@example.com');
  });

  it('burns the token on redemption, so a replay finds nothing', async () => {
    const redis = fakeRedis();
    const { token } = await createMagicLink('ada@example.com', redis);
    expect(await redeemMagicLink(token, redis)).toBe('ada@example.com');
    expect(await redeemMagicLink(token, redis)).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    expect(await redeemMagicLink('never-issued', fakeRedis())).toBeNull();
  });

  it('mints a distinct token per request', async () => {
    const redis = fakeRedis();
    const first = await createMagicLink('ada@example.com', redis);
    const second = await createMagicLink('ada@example.com', redis);
    expect(second.token).not.toBe(first.token);
    // Both stay live: asking for a second link must not silently invalidate a
    // first one the user is already reading in their inbox.
    expect(await redeemMagicLink(first.token, redis)).toBe('ada@example.com');
    expect(await redeemMagicLink(second.token, redis)).toBe('ada@example.com');
  });

  /**
   * Regression: this used to also return
   * `${PUBLIC_BASE_URL}/auth/magic-link?token=…`, a URL no route serves — a
   * user who followed it got a raw Fastify 404, and no deep-link handler
   * existed to catch it either (no URL scheme, no associated domain). The
   * product signs in by pasting the CODE, so the code is all the sender gets.
   *
   * If a landing page or deep link is ever built, this test is the place that
   * says so — and until then it fails the moment a dead URL comes back.
   */
  it('hands the sender a code, never a URL', async () => {
    const result = await createMagicLink('ada@example.com', fakeRedis());
    expect(result.token).toEqual(expect.any(String));
    const urlish = Object.values(result).filter(
      (v) => typeof v === 'string' && /https?:\/\//.test(v),
    );
    expect(urlish).toEqual([]);
  });
});

/**
 * The separation ADR-0012 turns on. A reset token and a sign-in token are the
 * same shape and the same TTL, so nothing but the key space stops one being
 * spent as the other — and spending a reset token as a sign-in would mean an
 * email that says "reset your password" silently signs the reader in.
 */
describe('password reset tokens', () => {
  it('stores the address under a single-use token with a TTL', async () => {
    const redis = fakeRedis();
    const { token, expiresInSeconds } = await createPasswordReset('ada@example.com', redis);
    expect(await redeemPasswordReset(token, redis)).toBe('ada@example.com');
    expect(expiresInSeconds).toBe(MAGIC_LINK_TTL_SECONDS);
  });

  it('burns the token on redemption', async () => {
    const redis = fakeRedis();
    const { token } = await createPasswordReset('ada@example.com', redis);
    expect(await redeemPasswordReset(token, redis)).toBe('ada@example.com');
    expect(await redeemPasswordReset(token, redis)).toBeNull();
  });

  it('cannot be redeemed as a magic link, and a magic link cannot be redeemed as a reset', async () => {
    const redis = fakeRedis();
    const reset = await createPasswordReset('ada@example.com', redis);
    const signIn = await createMagicLink('ada@example.com', redis);
    expect(await redeemMagicLink(reset.token, redis)).toBeNull();
    expect(await redeemPasswordReset(signIn.token, redis)).toBeNull();
    // …and neither was consumed by the other's failed attempt.
    expect(await redeemPasswordReset(reset.token, redis)).toBe('ada@example.com');
    expect(await redeemMagicLink(signIn.token, redis)).toBe('ada@example.com');
  });
});

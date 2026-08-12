import { describe, it, expect } from 'vitest';
import { redisKeys } from '@lilypad/shared';
import { createMagicLink, redeemMagicLink, type MagicLinkRedis } from './magicLink.js';

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

  it('embeds the token in the link it hands the sender', async () => {
    const { token, link } = await createMagicLink('ada@example.com', fakeRedis());
    expect(link).toContain(`token=${token}`);
  });
});

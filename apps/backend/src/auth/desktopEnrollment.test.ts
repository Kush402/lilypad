import { describe, it, expect } from 'vitest';
import { redisKeys } from '@lilypad/shared';
import {
  createDesktopEnrollmentCode,
  consumeDesktopEnrollmentCode,
  DESKTOP_ENROLLMENT_TTL_SECONDS,
  type DesktopEnrollmentRedis,
  type DesktopEnrollmentRecord,
} from './desktopEnrollment.js';

function fakeRedis(): DesktopEnrollmentRedis & {
  store: Map<string, { value: string; ttl: number }>;
} {
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

const desktop: DesktopEnrollmentRecord = {
  publicKey: 'the-desktops-public-key',
  fingerprint: 'desktop-abcdef',
  name: 'Work Mac',
  platform: 'macos',
};

describe('desktop enrollment codes', () => {
  it('binds the code to everything needed to enroll, so approval adds only identity', async () => {
    const redis = fakeRedis();
    const { code } = await createDesktopEnrollmentCode(desktop, redis);
    expect(await consumeDesktopEnrollmentCode(code, redis)).toEqual(desktop);
  });

  // The property that makes an intercepted code useless: it can only ever
  // enroll the key it was minted for, so an attacker cannot substitute theirs.
  it('carries the public key from mint time, not from approval', async () => {
    const redis = fakeRedis();
    const { code } = await createDesktopEnrollmentCode(desktop, redis);
    const stored = redis.store.get(redisKeys.desktopEnrollment(code));
    expect(stored?.value).toContain('the-desktops-public-key');
  });

  it('expires', async () => {
    const redis = fakeRedis();
    const { code, expiresInSeconds } = await createDesktopEnrollmentCode(desktop, redis);
    expect(expiresInSeconds).toBe(DESKTOP_ENROLLMENT_TTL_SECONDS);
    expect(redis.store.get(redisKeys.desktopEnrollment(code))?.ttl).toBe(
      DESKTOP_ENROLLMENT_TTL_SECONDS,
    );
  });

  // Two phones racing on one code must not both enroll.
  it('can be consumed exactly once', async () => {
    const redis = fakeRedis();
    const { code } = await createDesktopEnrollmentCode(desktop, redis);
    expect(await consumeDesktopEnrollmentCode(code, redis)).not.toBeNull();
    expect(await consumeDesktopEnrollmentCode(code, redis)).toBeNull();
  });

  it('returns null for a code it never issued', async () => {
    expect(await consumeDesktopEnrollmentCode('made-up', fakeRedis())).toBeNull();
  });

  it('mints a distinct code each time', async () => {
    const redis = fakeRedis();
    const first = await createDesktopEnrollmentCode(desktop, redis);
    const second = await createDesktopEnrollmentCode(desktop, redis);
    expect(second.code).not.toBe(first.code);
  });

  it('tolerates a corrupt record rather than rejecting on an authenticated path', async () => {
    const redis = fakeRedis();
    const { code } = await createDesktopEnrollmentCode(desktop, redis);
    redis.store.set(redisKeys.desktopEnrollment(code), { value: 'not json', ttl: 120 });
    expect(await consumeDesktopEnrollmentCode(code, redis)).toBeNull();
  });

  it('keeps an absent name and platform as null rather than inventing them', async () => {
    const redis = fakeRedis();
    const bare: DesktopEnrollmentRecord = {
      publicKey: 'k',
      fingerprint: 'desktop-nameless',
      name: null,
      platform: null,
    };
    const { code } = await createDesktopEnrollmentCode(bare, redis);
    expect(await consumeDesktopEnrollmentCode(code, redis)).toEqual(bare);
  });
});

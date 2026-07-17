import { describe, it, expect } from 'vitest';
import { RoomAuthStore, type RoomAuthRedis } from './roomAuth.js';

class FakeRedis implements RoomAuthRedis {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  async set(key: string, value: string, _mode: 'EX', ttl: number) {
    this.store.set(key, value);
    this.ttls.set(key, ttl);
    return 'OK';
  }
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
}

describe('RoomAuthStore', () => {
  it('verifies the desktop once recordDesktop has run', async () => {
    const store = new RoomAuthStore(new FakeRedis());
    await store.recordDesktop('room-1', 'desktop-01');

    expect(await store.verify('room-1', 'desktop', 'desktop-01')).toBe(true);
  });

  it('rejects a desktop deviceId that does not match the record', async () => {
    const store = new RoomAuthStore(new FakeRedis());
    await store.recordDesktop('room-1', 'desktop-01');

    expect(await store.verify('room-1', 'desktop', 'intruder-99')).toBe(false);
  });

  it('rejects any mobile registration before redemption records one', async () => {
    const store = new RoomAuthStore(new FakeRedis());
    await store.recordDesktop('room-1', 'desktop-01');

    expect(await store.verify('room-1', 'mobile', 'mobile-01')).toBe(false);
  });

  it('verifies the mobile once recordMobile has run, without disturbing the desktop record', async () => {
    const store = new RoomAuthStore(new FakeRedis());
    await store.recordDesktop('room-1', 'desktop-01');
    await store.recordMobile('room-1', 'desktop-01', 'mobile-01');

    expect(await store.verify('room-1', 'mobile', 'mobile-01')).toBe(true);
    expect(await store.verify('room-1', 'desktop', 'desktop-01')).toBe(true);
  });

  it('rejects a room with no record at all — closes the room-exhaustion path', async () => {
    // No recordDesktop/recordMobile ever ran for this roomId: an attacker
    // inventing a fresh roomId out of thin air must never verify.
    const store = new RoomAuthStore(new FakeRedis());
    expect(await store.verify('never-paired-room', 'desktop', 'anything')).toBe(false);
  });

  it('treats a corrupt stored record as unverifiable rather than throwing', async () => {
    const redis = new FakeRedis();
    await redis.set('lilypad:room-auth:room-1', 'not json', 'EX', 600);
    const store = new RoomAuthStore(redis);

    expect(await store.verify('room-1', 'desktop', 'desktop-01')).toBe(false);
  });

  it('writes with the configured TTL', async () => {
    const redis = new FakeRedis();
    const store = new RoomAuthStore(redis, 123);
    await store.recordDesktop('room-1', 'desktop-01');

    expect(redis.ttls.get('lilypad:room-auth:room-1')).toBe(123);
  });

  it('a mobile deviceId that matches a DIFFERENT room does not verify', async () => {
    const store = new RoomAuthStore(new FakeRedis());
    await store.recordDesktop('room-1', 'desktop-01');
    await store.recordMobile('room-1', 'desktop-01', 'mobile-01');
    await store.recordDesktop('room-2', 'desktop-02');

    expect(await store.verify('room-2', 'mobile', 'mobile-01')).toBe(false);
  });
});

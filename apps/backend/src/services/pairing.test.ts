import { describe, it, expect } from 'vitest';
import { createPairing, redeemPairing, PairingTokenError, type PairingRedis } from './pairing.js';
import { RoomAuthStore, type RoomAuthRedis } from './roomAuth.js';

/** In-memory Redis with single-use GETDEL semantics. */
class FakePairingRedis implements PairingRedis {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  async set(key: string, value: string, _mode: 'EX', ttl: number) {
    this.store.set(key, value);
    this.ttls.set(key, ttl);
    return 'OK';
  }
  async getdel(key: string) {
    const v = this.store.get(key) ?? null;
    this.store.delete(key);
    return v;
  }
}

/** In-memory Redis for the room-auth writes `createPairing`/`redeemPairing`
 * now also make. Every test below passes an explicit `RoomAuthStore`
 * wrapping this fake — never the functions' real default (which is backed
 * by the actual `redis` singleton and would otherwise try, and eventually
 * fail/hang on retries, to reach a real Redis that doesn't exist in this
 * test environment or in CI). */
class FakeRoomAuthRedis implements RoomAuthRedis {
  store = new Map<string, string>();
  async set(key: string, value: string, _mode: 'EX', _ttl: number) {
    this.store.set(key, value);
    return 'OK';
  }
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
}

function fakeRoomAuth() {
  const redis = new FakeRoomAuthRedis();
  return { roomAuth: new RoomAuthStore(redis), redis };
}

describe('pairing service', () => {
  it('mints a token with a 60s TTL and a room', async () => {
    const redis = new FakePairingRedis();
    const { roomAuth } = fakeRoomAuth();
    const res = await createPairing(
      { deviceId: 'desktop-abc', platform: 'macos' },
      redis,
      roomAuth,
    );
    expect(res.token.length).toBeGreaterThanOrEqual(16);
    expect(res.roomId).toBeTruthy();
    expect(res.expiresInSeconds).toBe(60);
    expect([...redis.ttls.values()][0]).toBe(60);
  });

  it('redeems a token exactly once (single-use)', async () => {
    const redis = new FakePairingRedis();
    const { roomAuth } = fakeRoomAuth();
    const created = await createPairing(
      { deviceId: 'desktop-abc', deviceName: 'mac', scopes: ['view', 'control'] },
      redis,
      roomAuth,
    );

    const redeemed = await redeemPairing(
      { token: created.token, deviceId: 'mobile-xyz' },
      redis,
      roomAuth,
    );
    expect(redeemed.roomId).toBe(created.roomId);
    expect(redeemed.scopes).toEqual(['view', 'control']);
    expect(redeemed.desktopDeviceName).toBe('mac');

    // Replay must fail — the token was burned.
    await expect(
      redeemPairing({ token: created.token, deviceId: 'mobile-xyz' }, redis, roomAuth),
    ).rejects.toBeInstanceOf(PairingTokenError);
  });

  it('rejects an unknown token', async () => {
    const redis = new FakePairingRedis();
    const { roomAuth } = fakeRoomAuth();
    await expect(
      redeemPairing({ token: 'nope-nope-nope-nope', deviceId: 'mobile-xyz' }, redis, roomAuth),
    ).rejects.toBeInstanceOf(PairingTokenError);
  });

  describe('room-auth wiring (docs/audit/m3/backend-security.md Finding 1)', () => {
    it('createPairing authorizes the desktop device for the minted room', async () => {
      const redis = new FakePairingRedis();
      const { roomAuth } = fakeRoomAuth();
      const created = await createPairing(
        { deviceId: 'desktop-abc', platform: 'macos' },
        redis,
        roomAuth,
      );

      expect(await roomAuth.verify(created.roomId, 'desktop', 'desktop-abc')).toBe(true);
      expect(await roomAuth.verify(created.roomId, 'desktop', 'someone-else')).toBe(false);
      // No mobile device has redeemed yet — nothing should verify as mobile.
      expect(await roomAuth.verify(created.roomId, 'mobile', 'mobile-xyz')).toBe(false);
    });

    it('redeemPairing extends the record with the redeeming mobile device', async () => {
      const redis = new FakePairingRedis();
      const { roomAuth } = fakeRoomAuth();
      const created = await createPairing(
        { deviceId: 'desktop-abc', platform: 'macos' },
        redis,
        roomAuth,
      );
      await redeemPairing({ token: created.token, deviceId: 'mobile-xyz' }, redis, roomAuth);

      expect(await roomAuth.verify(created.roomId, 'mobile', 'mobile-xyz')).toBe(true);
      // The desktop's own authorization must survive redemption untouched.
      expect(await roomAuth.verify(created.roomId, 'desktop', 'desktop-abc')).toBe(true);
    });

    it('a different device claiming the mobile seat does not verify after redemption', async () => {
      const redis = new FakePairingRedis();
      const { roomAuth } = fakeRoomAuth();
      const created = await createPairing(
        { deviceId: 'desktop-abc', platform: 'macos' },
        redis,
        roomAuth,
      );
      await redeemPairing({ token: created.token, deviceId: 'mobile-xyz' }, redis, roomAuth);

      expect(await roomAuth.verify(created.roomId, 'mobile', 'intruder-99')).toBe(false);
    });
  });
});

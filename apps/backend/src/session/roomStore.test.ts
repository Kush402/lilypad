import { describe, it, expect } from 'vitest';
import { RoomStore, type RoomKvStore, type RoomRecord } from './roomStore.js';

/** In-memory fake satisfying the subset of ioredis's real API `RoomStore`
 * needs — no live Redis required for these tests. */
class FakeRedis implements RoomKvStore {
  private data = new Map<string, string>();
  readonly setCalls: Array<{ key: string; ttlSeconds: number }> = [];
  readonly expireCalls: Array<{ key: string; ttlSeconds: number }> = [];

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string, _mode: 'EX' = 'EX', ttlSeconds = 3600): Promise<unknown> {
    this.setCalls.push({ key, ttlSeconds });
    this.data.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<unknown> {
    return this.data.delete(key) ? 1 : 0;
  }
  async keys(pattern: string): Promise<string[]> {
    // Only the trailing-`*` prefix form `RoomStore` actually uses.
    const prefix = pattern.replace(/\*$/, '');
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.data.get(k) ?? null);
  }
  async expire(key: string, ttlSeconds: number): Promise<unknown> {
    this.expireCalls.push({ key, ttlSeconds });
    // A real `EXPIRE` is a no-op (returns 0) on a key that isn't there — this
    // fake only needs to track the call, not simulate real TTL expiry.
    return this.data.has(key) ? 1 : 0;
  }
}

function record(overrides: Partial<RoomRecord> = {}): Omit<RoomRecord, 'updatedAt'> {
  return {
    id: 'room-1',
    fsmState: 'connected',
    sessionId: 'sess-1',
    scopes: ['view'],
    deviceIds: { desktop: 'desktop-01', mobile: 'mobile-01' },
    established: true,
    ...overrides,
  };
}

describe('RoomStore', () => {
  it('round-trips a saved record through loadAll', async () => {
    const nowRef = { t: 1_000 };
    const store = new RoomStore(new FakeRedis(), 3600, () => nowRef.t);

    await store.save(record());
    const all = await store.loadAll();

    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({ ...record(), updatedAt: 1_000 });
  });

  it('loadAll returns nothing once a record has been deleted', async () => {
    const store = new RoomStore(new FakeRedis());
    await store.save(record());
    await store.delete('room-1');

    expect(await store.loadAll()).toEqual([]);
  });

  it('loadAll returns every saved room, not just the first', async () => {
    const store = new RoomStore(new FakeRedis());
    await store.save(record({ id: 'room-1' }));
    await store.save(record({ id: 'room-2', deviceIds: { desktop: 'desktop-02' } }));

    const all = await store.loadAll();
    expect(all.map((r) => r.id).sort()).toEqual(['room-1', 'room-2']);
  });

  it('loadAll skips a corrupt record instead of throwing', async () => {
    const redis = new FakeRedis();
    await redis.set('lilypad:room:bad', 'not json');
    const store = new RoomStore(redis);
    await store.save(record({ id: 'room-1' }));

    const all = await store.loadAll();
    expect(all.map((r) => r.id)).toEqual(['room-1']);
  });

  it('loadAll returns an empty array with no round trip when nothing is stored', async () => {
    const store = new RoomStore(new FakeRedis());
    expect(await store.loadAll()).toEqual([]);
  });

  it('save persists with the configured TTL', async () => {
    const redis = new FakeRedis();
    const store = new RoomStore(redis, 999);

    await store.save(record());
    expect(redis.setCalls).toEqual([{ key: 'lilypad:room:room-1', ttlSeconds: 999 }]);
  });

  describe('touch (Fix 1 — cheap TTL refresh)', () => {
    it('refreshes the TTL with a plain EXPIRE, not a SET — no body rewrite', async () => {
      const redis = new FakeRedis();
      const store = new RoomStore(redis, 999);
      await store.save(record());
      redis.setCalls.length = 0; // only the initial save should have SET

      await store.touch('room-1');

      expect(redis.setCalls).toEqual([]); // touch never rewrites the body
      expect(redis.expireCalls).toEqual([{ key: 'lilypad:room:room-1', ttlSeconds: 999 }]);
    });

    it("leaves the record's contents completely untouched", async () => {
      const redis = new FakeRedis();
      const store = new RoomStore(redis, 3600, () => 1_000);
      await store.save(record());

      await store.touch('room-1');

      const [after] = await store.loadAll();
      // `updatedAt` still reflects the original `save`, not the `touch` — a
      // plain EXPIRE never rewrites the value, so nothing in the record
      // could have moved.
      expect(after).toEqual({ ...record(), updatedAt: 1_000 });
    });
  });
});

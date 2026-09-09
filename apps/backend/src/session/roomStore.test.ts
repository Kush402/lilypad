import { describe, it, expect } from 'vitest';
import { RoomStore, decodeRoomRecord, type RoomKvStore, type RoomRecord } from './roomStore.js';

/** In-memory fake satisfying the subset of ioredis's real API `RoomStore`
 * needs — no live Redis required for these tests. */
class FakeRedis implements RoomKvStore {
  private data = new Map<string, string>();
  readonly setCalls: Array<{ key: string; ttlSeconds: number }> = [];

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
  async scan(
    cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    size: number,
  ): Promise<[string, string[]]> {
    const keys = await this.keys(pattern);
    const start = Number(cursor);
    const next = start + size;
    return [next >= keys.length ? '0' : String(next), keys.slice(start, next)];
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.data.get(k) ?? null);
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
});

describe('RoomStore recovery is defensive about what it reads (L-250, L-251)', () => {
  /** Direct Redis writes, bypassing `save`, so a test can plant exactly the
   * bytes a bad deploy or a truncated write would leave behind. */
  async function plant(redis: FakeRedis, id: string, raw: string): Promise<void> {
    await redis.set(`lilypad:room:${id}`, raw, 'EX', 3600);
  }

  it('skips a stored `null` instead of handing it to the caller', async () => {
    // `JSON.parse(raw) as RoomRecord` accepted `"null"` — the cast is erased at
    // runtime — so `loadAll` returned `[null]` and the hub's resurrection loop
    // threw on `record.fsmState` during boot. One bad key took the process down
    // on every start, because the key is still there on the next start too.
    const redis = new FakeRedis();
    const store = new RoomStore(redis);
    await plant(redis, 'poison', 'null');
    await store.save(record({ id: 'good' }));

    const all = await store.loadAll();
    expect(all.map((r) => r.id)).toEqual(['good']);
    expect(all.every((r) => r !== null && typeof r === 'object')).toBe(true);
  });

  it('skips records that parse but are the wrong shape', async () => {
    const redis = new FakeRedis();
    const store = new RoomStore(redis);
    const bad: Record<string, string> = {
      'not-json': '{oops',
      'a-number': '42',
      'an-array': '[]',
      'no-id': JSON.stringify({
        fsmState: 'connected',
        scopes: [],
        deviceIds: {},
        established: true,
        updatedAt: 1,
      }),
      'unknown-state': JSON.stringify({
        id: 'x',
        fsmState: 'teleporting',
        scopes: [],
        deviceIds: {},
        established: true,
        updatedAt: 1,
      }),
      'scopes-not-array': JSON.stringify({
        id: 'x',
        fsmState: 'connected',
        scopes: 'view',
        deviceIds: {},
        established: true,
        updatedAt: 1,
      }),
      'device-not-string': JSON.stringify({
        id: 'x',
        fsmState: 'connected',
        scopes: [],
        deviceIds: { desktop: 7 },
        established: true,
        updatedAt: 1,
      }),
      'established-missing': JSON.stringify({
        id: 'x',
        fsmState: 'connected',
        scopes: [],
        deviceIds: {},
        updatedAt: 1,
      }),
      'updatedAt-nan': JSON.stringify({
        id: 'x',
        fsmState: 'connected',
        scopes: [],
        deviceIds: {},
        established: true,
        updatedAt: null,
      }),
      oversized: JSON.stringify({
        ...record({ id: 'huge' }),
        updatedAt: 1,
        pad: 'x'.repeat(20_000),
      }),
    };
    for (const [id, raw] of Object.entries(bad)) await plant(redis, id, raw);
    await store.save(record({ id: 'good' }));

    const all = await store.loadAll();
    expect(all.map((r) => r.id)).toEqual(['good']);
  });

  it('decodeRoomRecord accepts a real record unchanged', async () => {
    const redis = new FakeRedis();
    const store = new RoomStore(redis, 3600, () => 1_234);
    await store.save(record());
    const raw = await redis.get('lilypad:room:room-1');
    expect(decodeRoomRecord(raw as string)).toEqual({ ...record(), updatedAt: 1_234 });
  });

  it('decodes at most `limit` records, and asks Redis for no more than that', async () => {
    // The cap used to live in `RoomRegistry.resurrect`: every key was fetched,
    // parsed and materialised first, and only then thrown away. A Redis holding
    // far more room keys than this instance can hold was decoded in full at
    // boot — the "bounded by maxRooms" comment described the wrong step.
    const redis = new FakeRedis();
    const store = new RoomStore(redis);
    for (let i = 0; i < 50; i++) await store.save(record({ id: `room-${i}` }));

    const mget = redis.mget.bind(redis);
    let requested = 0;
    redis.mget = async (...keys: string[]) => {
      requested += keys.length;
      return mget(...keys);
    };

    const all = await store.loadAll(10);
    expect(all).toHaveLength(10);
    expect(requested).toBe(10);
  });
  it('skips unknown authority, wrong key identity and invalid timestamps', async () => {
    const redis = new FakeRedis();
    const store = new RoomStore(redis);
    for (const [id, overrides] of Object.entries({
      scope: { scopes: ['admin'] },
      role: { deviceIds: { intruder: 'x' } },
      time: { updatedAt: -1 },
      version: { version: 2 },
    })) {
      const raw = JSON.stringify({ ...record({ id }), updatedAt: 1, ...overrides });
      expect(decodeRoomRecord(raw)).toBeNull();
      await redis.set(`lilypad:room:${id}`, raw);
    }
    await redis.set(
      'lilypad:room:wrong-key',
      JSON.stringify({ ...record({ id: 'different' }), updatedAt: 1 }),
    );
    await store.save(record({ id: 'good' }));
    expect((await store.loadAll(1)).map((r) => r.id)).toEqual(['good']);
  });

  it('enforces bytes rather than UTF-16 code units', () => {
    expect(
      decodeRoomRecord(JSON.stringify({ ...record(), updatedAt: 1, padding: '界'.repeat(6000) })),
    ).toBeNull();
  });

  it('deduplicates scan results and bounds empty nonterminal scans', async () => {
    const redis = new FakeRedis();
    const store = new RoomStore(redis);
    await store.save(record());
    let calls = 0;
    redis.scan = async () => {
      calls++;
      return ['1', ['lilypad:room:room-1']];
    };
    expect(await store.loadAll(2)).toHaveLength(1);
    expect(calls).toBe(256);
    calls = 0;
    redis.scan = async () => {
      calls++;
      return ['1', []];
    };
    expect(await store.loadAll()).toEqual([]);
    expect(calls).toBe(256);
  });
});

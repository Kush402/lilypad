import { describe, it, expect } from 'vitest';
import { SessionManager, type KvStore } from './manager.js';
import { InvalidTransitionError } from './stateMachine.js';

class FakeKv implements KvStore {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.store.set(key, value);
    return 'OK';
  }
  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }
  async keys(pattern: string) {
    const prefix = pattern.replace(/\*$/, '');
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
  async mget(...keys: string[]) {
    return keys.map((k) => this.store.get(k) ?? null);
  }
}

describe('SessionManager', () => {
  it('creates a session in connecting state with the provided id', async () => {
    const mgr = new SessionManager(new FakeKv());
    const s = await mgr.create({
      id: 'sess-123',
      roomId: 'room-1',
      desktopDeviceId: 'desk-1',
      mobileDeviceId: 'mob-1',
      scopes: ['view', 'control'],
    });
    expect(s.id).toBe('sess-123');
    expect(s.state).toBe('connecting');
    expect(await mgr.get('sess-123')).toMatchObject({ roomId: 'room-1', state: 'connecting' });
  });

  it('applies valid transitions and persists them', async () => {
    const mgr = new SessionManager(new FakeKv());
    const s = await mgr.create({ id: 's', roomId: 'r', desktopDeviceId: null, scopes: ['view'] });
    await mgr.transition(s.id, 'negotiating');
    await mgr.transition(s.id, 'connected');
    expect((await mgr.get(s.id))?.state).toBe('connected');
  });

  it('rejects an illegal transition', async () => {
    const mgr = new SessionManager(new FakeKv());
    const s = await mgr.create({ id: 's', roomId: 'r', desktopDeviceId: null, scopes: ['view'] });
    await expect(mgr.transition(s.id, 'paused')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('end() drives the session to disconnected', async () => {
    const mgr = new SessionManager(new FakeKv());
    const s = await mgr.create({ id: 's', roomId: 'r', desktopDeviceId: null, scopes: ['view'] });
    await mgr.end(s.id, 'user hung up');
    expect((await mgr.get(s.id))?.state).toBe('disconnected');
  });
});

// ── boot-time orphan sweep (docs/audit/m3/testing-reliability.md Finding 5,
// redesign item 2) ────────────────────────────────────────────────────────

describe('SessionManager — orphaned-session sweep', () => {
  it('findStaleActive finds a non-terminal session with no recent update', async () => {
    let clock = 1_000_000;
    const mgr = new SessionManager(new FakeKv(), 3600, () => clock);
    const s = await mgr.create({ id: 's1', roomId: 'r', desktopDeviceId: 'd', scopes: ['view'] });
    await mgr.transition(s.id, 'negotiating'); // updatedAt stamped at clock=1_000_000

    clock += 30_000; // 30s with no further update — the crash-and-never-recovers case
    const stale = await mgr.findStaleActive(20_000, clock);
    expect(stale.map((r) => r.id)).toEqual(['s1']);
  });

  it('does not flag a session updated recently', async () => {
    let clock = 1_000_000;
    const mgr = new SessionManager(new FakeKv(), 3600, () => clock);
    await mgr.create({ id: 's1', roomId: 'r', desktopDeviceId: 'd', scopes: ['view'] });

    clock += 5_000; // well under the staleness threshold
    expect(await mgr.findStaleActive(20_000, clock)).toEqual([]);
  });

  it('does not flag a session already in a terminal state', async () => {
    let clock = 1_000_000;
    const mgr = new SessionManager(new FakeKv(), 3600, () => clock);
    const s = await mgr.create({ id: 's1', roomId: 'r', desktopDeviceId: 'd', scopes: ['view'] });
    await mgr.end(s.id, 'normal disconnect');

    clock += 30_000;
    expect(await mgr.findStaleActive(20_000, clock)).toEqual([]);
  });

  it('sweepOrphaned marks every stale session disconnected and returns the count', async () => {
    let clock = 1_000_000;
    const mgr = new SessionManager(new FakeKv(), 3600, () => clock);
    await mgr.create({ id: 's1', roomId: 'r1', desktopDeviceId: 'd1', scopes: ['view'] });
    await mgr.create({ id: 's2', roomId: 'r2', desktopDeviceId: 'd2', scopes: ['view'] });
    const fresh = await mgr.create({
      id: 's3',
      roomId: 'r3',
      desktopDeviceId: 'd3',
      scopes: ['view'],
    });

    clock += 30_000;
    // s3 gets a fresh touch right before the sweep — must survive it.
    await mgr.transition(fresh.id, 'negotiating');

    const swept = await mgr.sweepOrphaned(20_000, clock);

    expect(swept).toBe(2);
    expect((await mgr.get('s1'))?.state).toBe('disconnected');
    expect((await mgr.get('s2'))?.state).toBe('disconnected');
    expect((await mgr.get('s3'))?.state).toBe('negotiating');
  });

  it('bounds the "shows as active but is not" window to the sweep threshold, not the full TTL', async () => {
    // The exact regression this exists to prevent: without a sweep, an
    // orphaned session reads as "active" for up to its full TTL (up to an
    // hour) after the process that owned it is gone.
    let clock = 1_000_000;
    const mgr = new SessionManager(new FakeKv(), 3600, () => clock);
    await mgr.create({ id: 's1', roomId: 'r', desktopDeviceId: 'd', scopes: ['view'] });

    clock += 25_000; // well under the 3600s TTL, but past the 20s sweep threshold
    await mgr.sweepOrphaned(20_000, clock);

    expect((await mgr.get('s1'))?.state).toBe('disconnected');
  });
});

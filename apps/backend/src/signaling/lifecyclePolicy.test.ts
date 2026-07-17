import { describe, it, expect } from 'vitest';
import type { Peer } from './peer.js';
import { RoomRegistry } from './roomRegistry.js';
import { LifecyclePolicy } from './lifecyclePolicy.js';

class FakePeer implements Peer {
  send() {}
  close() {}
}

function setup(nowRef: { t: number }, heartbeatTimeoutMs = 30_000, reregisterGraceMs = 15_000) {
  const registry = new RoomRegistry();
  const policy = new LifecyclePolicy(
    registry,
    heartbeatTimeoutMs,
    reregisterGraceMs,
    () => nowRef.t,
  );
  return { registry, policy };
}

describe('LifecyclePolicy — grace expiry', () => {
  it('reports a vacated seat past grace only once the OTHER seat is also empty', () => {
    const nowRef = { t: 0 };
    const { registry, policy } = setup(nowRef, 30_000, 15_000);
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    const { room } = outcome;

    room.registerSeat('desktop', new FakePeer(), 'desktop-01', 0);
    room.registerSeat('mobile', new FakePeer(), 'mobile-01', 0);
    room.clearSeat('desktop');
    room.markVacated('desktop', 0);

    nowRef.t = 15_001; // past grace, but mobile is still seated
    expect(policy.findGraceExpired()).toEqual([]);

    room.clearSeat('mobile'); // now both gone
    const expired = policy.findGraceExpired();
    expect(expired).toHaveLength(1);
    expect(expired[0].role).toBe('desktop');
    expect(expired[0].reason).toBe('desktop did not re-register within grace');
  });

  it('reports nothing before the grace cutoff', () => {
    const nowRef = { t: 0 };
    const { registry, policy } = setup(nowRef, 30_000, 15_000);
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    const { room } = outcome;
    room.registerSeat('desktop', new FakePeer(), 'desktop-01', 0);
    room.clearSeat('desktop');
    room.markVacated('desktop', 0);

    nowRef.t = 5_000; // still within the 15s grace window
    expect(policy.findGraceExpired()).toEqual([]);
  });
});

describe('LifecyclePolicy — isSeatGoneForGood', () => {
  it('is true for a seat that was never part of the room', () => {
    const nowRef = { t: 0 };
    const { registry, policy } = setup(nowRef, 30_000, 15_000);
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    const { room } = outcome;
    room.registerSeat('desktop', new FakePeer(), 'desktop-01', 0);
    // mobile never registered.

    expect(policy.isSeatGoneForGood(room, 'mobile')).toBe(true);
  });

  it('is false for a seat that is currently occupied', () => {
    const nowRef = { t: 0 };
    const { registry, policy } = setup(nowRef, 30_000, 15_000);
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    const { room } = outcome;
    room.registerSeat('mobile', new FakePeer(), 'mobile-01', 0);

    expect(policy.isSeatGoneForGood(room, 'mobile')).toBe(false);
  });

  it('is false for a seat that just vacated, still within its own grace window', () => {
    // The regression case: a seat that dropped moments ago must not read as
    // "gone for good" just because it's currently unoccupied.
    const nowRef = { t: 0 };
    const { registry, policy } = setup(nowRef, 30_000, 15_000);
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    const { room } = outcome;
    room.registerSeat('mobile', new FakePeer(), 'mobile-01', 0);
    room.clearSeat('mobile');
    room.markVacated('mobile', 0);

    nowRef.t = 5; // a few ms later, nowhere near the 15s grace
    expect(policy.isSeatGoneForGood(room, 'mobile')).toBe(false);
  });

  it('is true once a vacated seat has passed its own grace window', () => {
    const nowRef = { t: 0 };
    const { registry, policy } = setup(nowRef, 30_000, 15_000);
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    const { room } = outcome;
    room.registerSeat('mobile', new FakePeer(), 'mobile-01', 0);
    room.clearSeat('mobile');
    room.markVacated('mobile', 0);

    nowRef.t = 15_001;
    expect(policy.isSeatGoneForGood(room, 'mobile')).toBe(true);
  });
});

describe('LifecyclePolicy — heartbeat staleness', () => {
  it('reports a seated peer whose lastSeen predates the cutoff', () => {
    const nowRef = { t: 0 };
    const { registry, policy } = setup(nowRef, 1_000, 15_000);
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    const { room } = outcome;
    const peer = new FakePeer();
    room.registerSeat('desktop', peer, 'desktop-01', 0);

    nowRef.t = 2_000; // past the 1s heartbeat timeout
    const stale = policy.findHeartbeatStale();
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ role: 'desktop', peer });
  });

  it('bumps lastSeen as it reports a stale peer, so it does not re-fire before close lands', () => {
    const nowRef = { t: 0 };
    const { registry, policy } = setup(nowRef, 1_000, 15_000);
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    const { room } = outcome;
    room.registerSeat('desktop', new FakePeer(), 'desktop-01', 0);

    nowRef.t = 2_000;
    expect(policy.findHeartbeatStale()).toHaveLength(1);
    // Same tick, called again immediately: lastSeen was just bumped to 2_000,
    // which is NOT stale relative to the same cutoff — no double-report.
    expect(policy.findHeartbeatStale()).toHaveLength(0);
  });

  it('ignores an empty seat even if it were somehow "stale" (no peer to close)', () => {
    const nowRef = { t: 0 };
    const { registry, policy } = setup(nowRef, 1_000, 15_000);
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    nowRef.t = 2_000;
    expect(policy.findHeartbeatStale()).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import type { DeviceKind, SignalingMessage } from '@lilypad/protocol';
import type { RoomRecord } from '../session/roomStore.js';
import type { Peer } from './peer.js';
import { RoomRegistry } from './roomRegistry.js';

class FakePeer implements Peer {
  send(_msg: SignalingMessage): void {}
  close(_code: number, _reason: string): void {}
}

/** Mirrors exactly what `SignalingHub.register` does on a successful claim:
 * `Room.registerSeat` first (the ONLY place a `Room`'s own `deviceIds` are
 * ever actually set for a live register), then `indexSeat`. `remove`'s
 * index cleanup reads the real `Room`'s `deviceIdFor` at removal time
 * (see `RoomRegistry.dropFromIndex`), so a test that indexed a device the
 * underlying `Room` never actually held would be testing a state the
 * production code path can never produce. */
function seat(registry: RoomRegistry, roomId: string, role: DeviceKind, deviceId: string): void {
  const outcome = registry.getOrCreate(roomId, () => {});
  if ('rejected' in outcome) throw new Error('unexpected rejection');
  const result = outcome.room.registerSeat(role, new FakePeer(), deviceId, 0);
  if (!result.ok) throw new Error(`unexpected seat rejection: ${result.reason}`);
  registry.indexSeat(roomId, role, deviceId);
}

function record(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    id: 'room-1',
    fsmState: 'connected',
    sessionId: 'sess-1',
    scopes: ['view'],
    deviceIds: { desktop: 'desktop-01', mobile: 'mobile-01' },
    established: true,
    updatedAt: 0,
    ...overrides,
  };
}

describe('RoomRegistry — resurrect', () => {
  it('inserts a resurrected room, retrievable by id', () => {
    const registry = new RoomRegistry();
    const inserted = registry.resurrect(record(), 1_000, () => {});

    expect(inserted).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.get('room-1')?.sessionId).toBe('sess-1');
  });

  it('refuses to resurrect over a room that is already live', () => {
    const registry = new RoomRegistry();
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');

    const inserted = registry.resurrect(record(), 1_000, () => {});
    expect(inserted).toBe(false);
    expect(registry.get('room-1')).toBe(outcome.room); // the live room, untouched
  });

  it('refuses to resurrect past the room cap', () => {
    const registry = new RoomRegistry(1);
    registry.getOrCreate('other-room', () => {});

    const inserted = registry.resurrect(record(), 1_000, () => {});
    expect(inserted).toBe(false);
    expect(registry.size).toBe(1);
  });

  it('indexes a resurrected room by both its deviceIds — restore-from-persistence populates the O(1) index directly, not through indexSeat', () => {
    const registry = new RoomRegistry();
    registry.resurrect(record(), 1_000, () => {});

    expect(registry.hasIndexedDevice('desktop', 'desktop-01')).toBe(true);
    expect(registry.hasIndexedDevice('mobile', 'mobile-01')).toBe(true);
    expect(registry.roomIdsForDevice('desktop', 'desktop-01')).toEqual(new Set(['room-1']));
  });

  it('never indexes a resurrected presence room', () => {
    const registry = new RoomRegistry();
    registry.resurrect(
      record({ id: 'presence:desktop-01', deviceIds: { desktop: 'desktop-01' } }),
      1_000,
      () => {},
    );

    expect(registry.hasIndexedDevice('desktop', 'desktop-01')).toBe(false);
  });

  it('only indexes whichever seats the record actually had (a resurrected room with only a desktop seat)', () => {
    const registry = new RoomRegistry();
    registry.resurrect(record({ deviceIds: { desktop: 'desktop-01' } }), 1_000, () => {});

    expect(registry.hasIndexedDevice('desktop', 'desktop-01')).toBe(true);
    expect(registry.hasIndexedDevice('mobile', 'mobile-01')).toBe(false);
  });
});

describe('RoomRegistry — device index (Fix 2: O(1) hasLiveSession)', () => {
  it('indexSeat makes the device findable; presence rooms are never indexed', () => {
    const registry = new RoomRegistry();
    seat(registry, 'room-1', 'desktop', 'desktop-01');
    expect(registry.hasIndexedDevice('desktop', 'desktop-01')).toBe(true);
    expect(registry.roomIdsForDevice('desktop', 'desktop-01')).toEqual(new Set(['room-1']));

    seat(registry, 'presence:desktop-01', 'desktop', 'desktop-01');
    expect(registry.hasIndexedDevice('desktop', 'desktop-01')).toBe(true); // unchanged by the presence call
    expect(registry.roomIdsForDevice('desktop', 'desktop-01')).toEqual(new Set(['room-1']));
  });

  it('an unknown device reports not-indexed and an empty room set', () => {
    const registry = new RoomRegistry();
    expect(registry.hasIndexedDevice('desktop', 'nobody')).toBe(false);
    expect(registry.roomIdsForDevice('desktop', 'nobody').size).toBe(0);
  });

  it('is per-role: the same deviceId string indexed as a desktop does not answer for mobile', () => {
    const registry = new RoomRegistry();
    seat(registry, 'room-1', 'desktop', 'shared-id');
    expect(registry.hasIndexedDevice('desktop', 'shared-id')).toBe(true);
    expect(registry.hasIndexedDevice('mobile', 'shared-id')).toBe(false);
  });

  it('indexSeat is idempotent — calling it again for the same room/role/device does not duplicate the entry', () => {
    const registry = new RoomRegistry();
    const outcome = registry.getOrCreate('room-1', () => {});
    if ('rejected' in outcome) throw new Error('unexpected rejection');
    const peer = new FakePeer();
    outcome.room.registerSeat('desktop', peer, 'desktop-01', 0);
    registry.indexSeat('room-1', 'desktop', 'desktop-01');
    registry.indexSeat('room-1', 'desktop', 'desktop-01'); // e.g. a zombie-socket reconnect
    registry.indexSeat('room-1', 'desktop', 'desktop-01'); // e.g. a grace reclaim
    expect(registry.roomIdsForDevice('desktop', 'desktop-01').size).toBe(1);
  });

  it('a device seated in two different rooms is found in both', () => {
    const registry = new RoomRegistry();
    seat(registry, 'room-1', 'desktop', 'desktop-01');
    seat(registry, 'room-2', 'desktop', 'desktop-01');
    expect(registry.roomIdsForDevice('desktop', 'desktop-01')).toEqual(
      new Set(['room-1', 'room-2']),
    );
  });

  it('remove() drops the room from the index for BOTH seats it held', () => {
    const registry = new RoomRegistry();
    seat(registry, 'room-1', 'desktop', 'desktop-01');
    seat(registry, 'room-1', 'mobile', 'mobile-01');

    registry.remove('room-1');

    expect(registry.hasIndexedDevice('desktop', 'desktop-01')).toBe(false);
    expect(registry.hasIndexedDevice('mobile', 'mobile-01')).toBe(false);
    expect(registry.roomIdsForDevice('desktop', 'desktop-01').size).toBe(0);
  });

  it('removing one room leaves an unrelated room for the same device untouched', () => {
    const registry = new RoomRegistry();
    seat(registry, 'room-1', 'desktop', 'desktop-01');
    seat(registry, 'room-2', 'desktop', 'desktop-01');

    registry.remove('room-1');

    expect(registry.hasIndexedDevice('desktop', 'desktop-01')).toBe(true);
    expect(registry.roomIdsForDevice('desktop', 'desktop-01')).toEqual(new Set(['room-2']));
  });

  it('remove() on an already-absent id is a harmless no-op', () => {
    const registry = new RoomRegistry();
    expect(() => registry.remove('never-existed')).not.toThrow();
  });

  it('a room recreated with the same id after removal starts with a clean index — a fresh room can seat a different device under the same roomId', () => {
    const registry = new RoomRegistry();
    seat(registry, 'room-1', 'desktop', 'desktop-01');
    registry.remove('room-1');

    seat(registry, 'room-1', 'desktop', 'desktop-02'); // reused id, brand-new Room instance

    expect(registry.hasIndexedDevice('desktop', 'desktop-01')).toBe(false);
    expect(registry.hasIndexedDevice('desktop', 'desktop-02')).toBe(true);
  });
});

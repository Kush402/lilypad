import { describe, it, expect } from 'vitest';
import type { RoomRecord } from '../session/roomStore.js';
import { RoomRegistry } from './roomRegistry.js';

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
});

import { describe, it, expect } from 'vitest';
import type { Peer } from './peer.js';
import { Room } from './room.js';

class FakePeer implements Peer {
  send() {}
  close() {}
}

function makeRoom() {
  return Room.create('room-1', () => {});
}

describe('Room — seat registration', () => {
  it('claims an empty seat', () => {
    const room = makeRoom();
    const peer = new FakePeer();
    const result = room.registerSeat('desktop', peer, 'device-01', 100);
    expect(result).toEqual({ ok: true, reclaimed: false });
    expect(room.seat('desktop')).toBe(peer);
    expect(room.deviceIdFor('desktop')).toBe('device-01');
  });

  it('rejects a seat already held by a different peer', () => {
    const room = makeRoom();
    room.registerSeat('desktop', new FakePeer(), 'device-01', 100);
    const result = room.registerSeat('desktop', new FakePeer(), 'device-02', 200);
    expect(result).toEqual({ ok: false, reason: 'seat_taken' });
  });

  it('treats re-registering the SAME peer object as a no-op success, not seat_taken', () => {
    const room = makeRoom();
    const peer = new FakePeer();
    room.registerSeat('desktop', peer, 'device-01', 100);
    const result = room.registerSeat('desktop', peer, 'device-01', 200);
    expect(result).toEqual({ ok: true, reclaimed: false });
  });

  it('lets the SAME device reclaim a vacated seat within grace', () => {
    const room = makeRoom();
    room.registerSeat('desktop', new FakePeer(), 'device-01', 100);
    room.clearSeat('desktop');
    room.markVacated('desktop', 150);

    const result = room.registerSeat('desktop', new FakePeer(), 'device-01', 200);
    expect(result).toEqual({ ok: true, reclaimed: true });
    expect(room.isVacatedPastGrace('desktop', 1_000_000)).toBe(false); // vacatedAt cleared
  });

  it('evicts a zombie socket when the SAME device re-registers on a new peer', () => {
    const room = makeRoom();
    const zombie = new FakePeer();
    const fresh = new FakePeer();
    room.registerSeat('mobile', zombie, 'device-01', 100);

    const result = room.registerSeat('mobile', fresh, 'device-01', 200);
    expect(result).toEqual({ ok: true, reclaimed: false, evicted: zombie });
    expect(room.seat('mobile')).toBe(fresh);
    expect(room.deviceIdFor('mobile')).toBe('device-01');
  });

  it('zombie eviction clears a pending vacatedAt (no stale grace bookkeeping)', () => {
    const room = makeRoom();
    const zombie = new FakePeer();
    room.registerSeat('mobile', zombie, 'device-01', 100);
    room.markVacated('mobile', 150);

    room.registerSeat('mobile', new FakePeer(), 'device-01', 200);
    expect(room.isVacatedPastGrace('mobile', 1_000_000)).toBe(false);
  });

  it('rejects a DIFFERENT device claiming a vacated seat within grace', () => {
    const room = makeRoom();
    room.registerSeat('desktop', new FakePeer(), 'device-01', 100);
    room.clearSeat('desktop');
    room.markVacated('desktop', 150);

    const result = room.registerSeat('desktop', new FakePeer(), 'intruder-device', 200);
    expect(result).toEqual({ ok: false, reason: 'seat_reserved' });
  });
});

describe('Room — liveness', () => {
  it('is heartbeat-stale only when a peer is seated and its lastSeen predates the cutoff', () => {
    const room = makeRoom();
    expect(room.isHeartbeatStale('desktop', 1000)).toBe(false); // no seat at all

    room.registerSeat('desktop', new FakePeer(), 'device-01', 100);
    expect(room.isHeartbeatStale('desktop', 50)).toBe(false); // lastSeen(100) >= cutoff(50)
    expect(room.isHeartbeatStale('desktop', 500)).toBe(true); // lastSeen(100) < cutoff(500)

    room.bumpLastSeen('desktop', 600);
    expect(room.isHeartbeatStale('desktop', 500)).toBe(false);
  });

  it('is vacated-past-grace only once vacatedAt predates the cutoff', () => {
    const room = makeRoom();
    expect(room.isVacatedPastGrace('desktop', 1000)).toBe(false); // never vacated

    room.markVacated('desktop', 100);
    expect(room.isVacatedPastGrace('desktop', 50)).toBe(false);
    expect(room.isVacatedPastGrace('desktop', 500)).toBe(true);
  });
});

describe('Room — established flag', () => {
  it('starts unestablished and only moves one way', () => {
    const room = makeRoom();
    expect(room.isEstablished()).toBe(false);
    room.markEstablished();
    expect(room.isEstablished()).toBe(true);
  });
});

describe('Room — FSM delegation', () => {
  it('starts idle and follows the same legal-transition table as SessionStateMachine', () => {
    const room = makeRoom();
    expect(room.fsmState()).toBe('idle');
    expect(room.tryFsm('pairing')).toBe(true);
    expect(room.fsmState()).toBe('pairing');
  });

  it('rejects an illegal transition and leaves state unchanged', () => {
    const room = makeRoom();
    expect(room.tryFsm('connected')).toBe(false); // can't skip straight from idle
    expect(room.fsmState()).toBe('idle');
  });

  it('reports terminal states via fsmIsTerminal', () => {
    const room = makeRoom();
    expect(room.fsmIsTerminal()).toBe(false);
    room.tryFsm('pairing');
    room.tryFsm('disconnected');
    expect(room.fsmIsTerminal()).toBe(true);
  });

  it("invokes onStateChange with the room's CURRENT sessionId at the moment of each transition", () => {
    const seen: Array<{ sessionId: string | undefined; from: string; to: string }> = [];
    const room = Room.create('room-x', (_roomId, sessionId, from, to) => {
      seen.push({ sessionId, from, to });
    });

    room.tryFsm('pairing'); // no sessionId minted yet
    room.sessionId = 'sess-123'; // mimics `approve()` minting it before the next transition
    room.tryFsm('waiting_approval');

    expect(seen[0]).toEqual({ sessionId: undefined, from: 'idle', to: 'pairing' });
    expect(seen[1]).toEqual({ sessionId: 'sess-123', from: 'pairing', to: 'waiting_approval' });
  });
});

describe('Room — occupied seats', () => {
  it('lists only seats that are currently filled', () => {
    const room = makeRoom();
    expect(room.occupiedSeats()).toEqual([]);

    const desktopPeer = new FakePeer();
    room.registerSeat('desktop', desktopPeer, 'device-01', 100);
    expect(room.occupiedSeats()).toEqual([{ role: 'desktop', peer: desktopPeer }]);

    const mobilePeer = new FakePeer();
    room.registerSeat('mobile', mobilePeer, 'device-02', 100);
    expect(room.occupiedSeats()).toEqual([
      { role: 'desktop', peer: desktopPeer },
      { role: 'mobile', peer: mobilePeer },
    ]);
  });

  it('otherRole always returns the counterpart', () => {
    const room = makeRoom();
    expect(room.otherRole('desktop')).toBe('mobile');
    expect(room.otherRole('mobile')).toBe('desktop');
  });
});

describe('Room — persistence (toRecord / resurrect)', () => {
  it('toRecord snapshots everything needed to resurrect this room', () => {
    const room = makeRoom();
    room.registerSeat('desktop', new FakePeer(), 'desktop-01', 100);
    room.registerSeat('mobile', new FakePeer(), 'mobile-01', 100);
    room.tryFsm('pairing');
    room.sessionId = 'sess-1';
    room.scopes = ['view', 'control'];
    room.markEstablished();

    expect(room.toRecord()).toEqual({
      id: 'room-1',
      fsmState: 'pairing',
      sessionId: 'sess-1',
      scopes: ['view', 'control'],
      deviceIds: { desktop: 'desktop-01', mobile: 'mobile-01' },
      established: true,
    });
  });

  it('resurrect rebuilds a room with both seats empty but vacated (not occupied)', () => {
    const room = Room.resurrect(
      {
        id: 'room-1',
        fsmState: 'connected',
        sessionId: 'sess-1',
        scopes: ['control'],
        deviceIds: { desktop: 'desktop-01', mobile: 'mobile-01' },
        established: true,
        updatedAt: 0,
      },
      1_000, // resurrected "now"
      () => {},
    );

    expect(room.fsmState()).toBe('connected');
    expect(room.sessionId).toBe('sess-1');
    expect(room.scopes).toEqual(['control']);
    expect(room.isEstablished()).toBe(true);
    expect(room.hasSeat('desktop')).toBe(false);
    expect(room.hasSeat('mobile')).toBe(false);
    expect(room.deviceIdFor('desktop')).toBe('desktop-01');
    expect(room.deviceIdFor('mobile')).toBe('mobile-01');
    // Vacated AT resurrection time, not before it — gets the full grace
    // window from here, same as any other mid-session drop.
    expect(room.isVacatedPastGrace('desktop', 999)).toBe(false);
    expect(room.isVacatedPastGrace('desktop', 1_001)).toBe(true);
  });

  it('resurrect only marks device slots that were actually occupied as vacated', () => {
    const room = Room.resurrect(
      {
        id: 'room-1',
        fsmState: 'waiting_approval',
        scopes: ['view'],
        deviceIds: { desktop: 'desktop-01' }, // mobile never registered
        established: false,
        updatedAt: 0,
      },
      1_000,
      () => {},
    );

    expect(room.isVacatedPastGrace('desktop', 1_001)).toBe(true);
    expect(room.isVacatedPastGrace('mobile', 1_001)).toBe(false); // never here, not "vacated"
  });

  it("resurrect's onStateChange sees the record's restored sessionId, not undefined", () => {
    const seen: Array<{ sessionId: string | undefined; from: string; to: string }> = [];
    const room = Room.resurrect(
      {
        id: 'room-1',
        fsmState: 'connected',
        sessionId: 'sess-1',
        scopes: ['view'],
        deviceIds: {},
        established: true,
        updatedAt: 0,
      },
      1_000,
      (_roomId, sessionId, from, to) => seen.push({ sessionId, from, to }),
    );

    room.tryFsm('paused');
    expect(seen).toEqual([{ sessionId: 'sess-1', from: 'connected', to: 'paused' }]);
  });
});

describe('Room — pending relay', () => {
  const pairRequest = {
    type: 'pair-request' as const,
    roomId: 'room-1',
    from: 'mobile' as const,
    ts: 0,
    payload: { deviceId: 'mobile-01', deviceName: 'phone', requestedScopes: ['view' as const] },
  };

  it('replays buffered frames in order and clears the queue', () => {
    const room = makeRoom();
    expect(room.enqueuePending('desktop', pairRequest)).toBe(true);
    expect(room.takePending('desktop')).toEqual([pairRequest]);
    expect(room.takePending('desktop')).toEqual([]);
  });

  it('refuses to grow past MAX_PENDING', () => {
    const room = makeRoom();
    for (let i = 0; i < Room.MAX_PENDING; i++) {
      expect(room.enqueuePending('desktop', pairRequest)).toBe(true);
    }
    expect(room.enqueuePending('desktop', pairRequest)).toBe(false);
    expect(room.takePending('desktop')).toHaveLength(Room.MAX_PENDING);
  });
});

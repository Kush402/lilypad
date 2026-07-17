import { describe, it, expect } from 'vitest';
import type { DeviceKind, SignalingMessage } from '@lilypad/protocol';
import type { Peer } from './peer.js';
import { Room } from './room.js';
import { MessageRouter } from './messageRouter.js';

class FakePeer implements Peer {
  send() {}
  close() {}
}

const ROOM = 'room-1';

function msg(type: string, from: DeviceKind, payload: unknown): SignalingMessage {
  return { type, roomId: ROOM, from, ts: 0, payload } as SignalingMessage;
}

function makeRoom() {
  return Room.create(ROOM, () => {});
}

/** A room with both seats filled — the shape most routing decisions need. */
function connectedSeatsRoom() {
  const room = makeRoom();
  room.registerSeat('desktop', new FakePeer(), 'desktop-01', 0);
  room.registerSeat('mobile', new FakePeer(), 'mobile-01', 0);
  return room;
}

describe('MessageRouter — no-ops', () => {
  it('register is a no-op ack', () => {
    const router = new MessageRouter();
    const room = makeRoom();
    expect(router.route(room, 'desktop', msg('register', 'desktop', {}))).toEqual([]);
  });

  it('heartbeat is a no-op (lastSeen already bumped by the caller)', () => {
    const router = new MessageRouter();
    const room = makeRoom();
    expect(router.route(room, 'desktop', msg('heartbeat', 'desktop', {}))).toEqual([]);
  });
});

describe('MessageRouter — ping/pong', () => {
  it('responds to the sender with pong', () => {
    const router = new MessageRouter();
    const room = makeRoom();
    const actions = router.route(room, 'mobile', msg('ping', 'mobile', {}));
    expect(actions).toEqual([{ kind: 'respond', to: 'mobile', type: 'pong', payload: {} }]);
  });
});

describe('MessageRouter — pair-request', () => {
  it('from mobile: sets scopes, transitions to waiting_approval, relays to desktop', () => {
    const router = new MessageRouter();
    const room = makeRoom();
    room.tryFsm('pairing');
    const m = msg('pair-request', 'mobile', {
      deviceId: 'mobile-01',
      deviceName: 'phone',
      requestedScopes: ['view', 'control'],
    });

    const actions = router.route(room, 'mobile', m);

    expect(room.scopes).toEqual(['view', 'control']);
    expect(room.fsmState()).toBe('waiting_approval');
    expect(actions).toEqual([{ kind: 'relay', to: 'desktop', msg: m }]);
  });

  it('from desktop: rejected as forbidden, room state untouched', () => {
    const router = new MessageRouter();
    const room = makeRoom();
    const actions = router.route(
      room,
      'desktop',
      msg('pair-request', 'desktop', {
        deviceId: 'd',
        deviceName: null,
        requestedScopes: ['view'],
      }),
    );
    expect(actions).toEqual([
      {
        kind: 'reject',
        to: 'desktop',
        code: 'forbidden',
        message: 'only the mobile may send this',
      },
    ]);
    expect(room.fsmState()).toBe('idle'); // untouched
  });
});

describe('MessageRouter — pair-approved', () => {
  it('from desktop with both seats present: approve action', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const actions = router.route(
      room,
      'desktop',
      msg('pair-approved', 'desktop', { grantedScopes: ['view'] }),
    );
    expect(actions).toEqual([{ kind: 'approve', grantedScopes: ['view'] }]);
  });

  it('rejects peer_missing when the mobile seat is empty', () => {
    const router = new MessageRouter();
    const room = makeRoom();
    room.registerSeat('desktop', new FakePeer(), 'desktop-01', 0); // mobile never joined
    const actions = router.route(
      room,
      'desktop',
      msg('pair-approved', 'desktop', { grantedScopes: ['view'] }),
    );
    expect(actions).toEqual([
      {
        kind: 'reject',
        to: 'desktop',
        code: 'peer_missing',
        message: 'both peers must be present to approve',
      },
    ]);
  });

  it('from mobile: rejected as forbidden', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const actions = router.route(
      room,
      'mobile',
      msg('pair-approved', 'mobile', { grantedScopes: ['view'] }),
    );
    expect(actions).toEqual([
      {
        kind: 'reject',
        to: 'mobile',
        code: 'forbidden',
        message: 'only the desktop may send this',
      },
    ]);
  });
});

describe('MessageRouter — pair-denied', () => {
  it('from desktop: relays to mobile AND ends the room', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const m = msg('pair-denied', 'desktop', { reason: 'not now' });
    const actions = router.route(room, 'desktop', m);
    expect(actions).toEqual([
      { kind: 'relay', to: 'mobile', msg: m },
      { kind: 'end', reason: 'denied by desktop' },
    ]);
  });
});

describe('MessageRouter — offer/answer', () => {
  it('offer from desktop: transitions to negotiating, relays to mobile', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    room.tryFsm('pairing');
    room.tryFsm('waiting_approval');
    room.tryFsm('connecting');
    const m = msg('offer', 'desktop', { type: 'offer', sdp: 'v=0' });

    const actions = router.route(room, 'desktop', m);

    expect(room.fsmState()).toBe('negotiating');
    expect(actions).toEqual([{ kind: 'relay', to: 'mobile', msg: m }]);
  });

  it('offer from mobile: rejected as forbidden', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const actions = router.route(
      room,
      'mobile',
      msg('offer', 'mobile', { type: 'offer', sdp: 'x' }),
    );
    expect(actions).toEqual([
      {
        kind: 'reject',
        to: 'mobile',
        code: 'forbidden',
        message: 'only the desktop may send this',
      },
    ]);
  });

  it('answer from mobile: transitions to connected, marks established, relays to desktop', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    room.tryFsm('pairing');
    room.tryFsm('waiting_approval');
    room.tryFsm('connecting');
    room.tryFsm('negotiating');
    const m = msg('answer', 'mobile', { type: 'answer', sdp: 'v=0-ans' });

    const actions = router.route(room, 'mobile', m);

    expect(room.fsmState()).toBe('connected');
    expect(room.isEstablished()).toBe(true);
    expect(actions).toEqual([{ kind: 'relay', to: 'desktop', msg: m }]);
  });

  it('answer arriving while the room is still idle: the illegal FSM transition is silently ignored (current, pre-existing behavior — not fixed by this decomposition), yet the relay and established-flag side effects still happen', () => {
    // This is the exact scenario the M3 architecture audit calls out as
    // worth a first-class regression test: `room.tryFsm(...)`'s bool result
    // is discarded here just like it was in the original `dispatch` switch.
    // A protocol hardening fix (reject instead of silently relay) is a
    // deliberate follow-up, not something this pass changes.
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    expect(room.fsmState()).toBe('idle');

    const m = msg('answer', 'mobile', { type: 'answer', sdp: 'v=0-ans' });
    const actions = router.route(room, 'mobile', m);

    expect(room.fsmState()).toBe('idle'); // tryFsm('connected') from 'idle' is illegal, rejected internally
    expect(room.isEstablished()).toBe(true); // ...but this still ran unconditionally
    expect(actions).toEqual([{ kind: 'relay', to: 'desktop', msg: m }]); // ...and so did this
  });

  it('answer from desktop: rejected as forbidden', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const actions = router.route(
      room,
      'desktop',
      msg('answer', 'desktop', { type: 'answer', sdp: 'x' }),
    );
    expect(actions).toEqual([
      {
        kind: 'reject',
        to: 'desktop',
        code: 'forbidden',
        message: 'only the mobile may send this',
      },
    ]);
  });
});

describe('MessageRouter — ice-candidate', () => {
  it('relays to the counterpart regardless of sender', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const fromDesktop = msg('ice-candidate', 'desktop', { candidate: 'cand-d' });
    expect(router.route(room, 'desktop', fromDesktop)).toEqual([
      { kind: 'relay', to: 'mobile', msg: fromDesktop },
    ]);

    const fromMobile = msg('ice-candidate', 'mobile', { candidate: 'cand-m' });
    expect(router.route(room, 'mobile', fromMobile)).toEqual([
      { kind: 'relay', to: 'desktop', msg: fromMobile },
    ]);
  });
});

describe('MessageRouter — frame-size', () => {
  it('relays desktop → mobile (the phone needs it for letterbox-aware touch mapping)', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const m = msg('frame-size', 'desktop', { width: 2560, height: 1600, mode: 'motion' });
    expect(router.route(room, 'desktop', m)).toEqual([{ kind: 'relay', to: 'mobile', msg: m }]);
  });

  it('rejects a mobile sender (a phone has no capture surface to describe)', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const actions = router.route(
      room,
      'mobile',
      msg('frame-size', 'mobile', { width: 1, height: 1, mode: 'motion' }),
    );
    expect(actions).toEqual([
      {
        kind: 'reject',
        to: 'mobile',
        code: 'forbidden',
        message: 'only the desktop may send this',
      },
    ]);
  });
});

describe('MessageRouter — set-capture-mode', () => {
  it('relays mobile → desktop (only the desktop can rebuild its capture pipeline)', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const m = msg('set-capture-mode', 'mobile', { mode: 'text' });
    expect(router.route(room, 'mobile', m)).toEqual([{ kind: 'relay', to: 'desktop', msg: m }]);
  });

  it('rejects a desktop sender (only the mobile viewer has the mode-toggle UI)', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const actions = router.route(
      room,
      'desktop',
      msg('set-capture-mode', 'desktop', { mode: 'text' }),
    );
    expect(actions).toEqual([
      {
        kind: 'reject',
        to: 'desktop',
        code: 'forbidden',
        message: 'only the mobile may send this',
      },
    ]);
  });
});

describe('MessageRouter — clipboard-update', () => {
  it('relays desktop → mobile (the desktop-OS-clipboard-changed direction)', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const m = msg('clipboard-update', 'desktop', { text: 'copied from the Mac' });
    expect(router.route(room, 'desktop', m)).toEqual([{ kind: 'relay', to: 'mobile', msg: m }]);
  });

  it('rejects a mobile sender (phone → desktop clipboard sync already travels over the DataChannel, not signaling)', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const actions = router.route(room, 'mobile', msg('clipboard-update', 'mobile', { text: 'x' }));
    expect(actions).toEqual([
      {
        kind: 'reject',
        to: 'mobile',
        code: 'forbidden',
        message: 'only the desktop may send this',
      },
    ]);
  });
});

describe('MessageRouter — renegotiate', () => {
  it('always targets desktop, even if the desktop itself sent it (pins the existing quirk)', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    room.tryFsm('pairing');
    room.tryFsm('waiting_approval');
    room.tryFsm('connecting');
    room.tryFsm('negotiating');
    room.tryFsm('connected');

    const fromMobile = msg('renegotiate', 'mobile', { iceRestart: true });
    expect(router.route(room, 'mobile', fromMobile)).toEqual([
      { kind: 'relay', to: 'desktop', msg: fromMobile },
    ]);
    expect(room.fsmState()).toBe('negotiating');

    room.tryFsm('connected');
    const fromDesktop = msg('renegotiate', 'desktop', { iceRestart: true });
    expect(router.route(room, 'desktop', fromDesktop)).toEqual([
      { kind: 'relay', to: 'desktop', msg: fromDesktop },
    ]);
  });
});

describe('MessageRouter — pause/resume', () => {
  /** Drive a room to `connected` — `pause` is only a legal transition from
   * there (`connected -> paused`), and `resume` needs a preceding `pause`. */
  function connectedRoom() {
    const room = connectedSeatsRoom();
    room.tryFsm('pairing');
    room.tryFsm('waiting_approval');
    room.tryFsm('connecting');
    room.tryFsm('negotiating');
    room.tryFsm('connected');
    return room;
  }

  it('pause transitions to paused and relays to the counterpart', () => {
    const router = new MessageRouter();
    const room = connectedRoom();
    const m = msg('pause', 'mobile', { reason: 'backgrounded' });
    expect(router.route(room, 'mobile', m)).toEqual([{ kind: 'relay', to: 'desktop', msg: m }]);
    expect(room.fsmState()).toBe('paused');
  });

  it('resume transitions to connected and relays to the counterpart', () => {
    const router = new MessageRouter();
    const room = connectedRoom();
    room.tryFsm('paused');
    const m = msg('resume', 'mobile', {});
    expect(router.route(room, 'mobile', m)).toEqual([{ kind: 'relay', to: 'desktop', msg: m }]);
    expect(room.fsmState()).toBe('connected');
  });
});

describe('MessageRouter — disconnect', () => {
  it('relays to the counterpart AND ends the room, attributing the sender', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    const m = msg('disconnect', 'mobile', { reason: 'bye' });
    const actions = router.route(room, 'mobile', m);
    expect(actions).toEqual([
      { kind: 'relay', to: 'desktop', msg: m },
      { kind: 'end', reason: 'mobile disconnected' },
    ]);
  });
});

describe('MessageRouter — server-originated types from a client', () => {
  it('rejects session-start, session-end, pong, and error as unexpected_type', () => {
    const router = new MessageRouter();
    const room = connectedSeatsRoom();
    for (const type of ['session-start', 'session-end', 'pong', 'error']) {
      const actions = router.route(room, 'desktop', msg(type, 'desktop', {}));
      expect(actions).toEqual([
        {
          kind: 'reject',
          to: 'desktop',
          code: 'unexpected_type',
          message: `'${type}' not accepted from a client`,
        },
      ]);
    }
  });
});

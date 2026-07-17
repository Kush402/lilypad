import { describe, it, expect } from 'vitest';
import type { SignalingMessage, DeviceKind, IceServer } from '@lilypad/protocol';
import { RoomStore, type RoomKvStore } from '../session/roomStore.js';
import { SignalingHub, type Peer } from './hub.js';

/** In-memory fake Redis for the resurrection tests below — shared across two
 * `SignalingHub` instances to simulate two different backend processes
 * (or a restart) reading/writing the same Redis. */
class FakeRedis implements RoomKvStore {
  private data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.data.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<unknown> {
    return this.data.delete(key) ? 1 : 0;
  }
  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, '');
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.data.get(k) ?? null);
  }
}

class FakePeer implements Peer {
  sent: SignalingMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(msg: SignalingMessage) {
    this.sent.push(msg);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  types() {
    return this.sent.map((m) => m.type);
  }
  find<T extends SignalingMessage['type']>(type: T) {
    return this.sent.find((m) => m.type === type) as
      Extract<SignalingMessage, { type: T }> | undefined;
  }
}

const ROOM = 'room-1';
const ICE: IceServer[] = [
  { urls: 'stun:localhost:3478' },
  { urls: 'turn:localhost:3478', username: 'u', credential: 'c' },
];

function makeHub() {
  return new SignalingHub({
    buildIceServers: () => ICE,
    now: () => 0,
  });
}

const reg = (role: DeviceKind, deviceId: string) => ({
  type: 'register',
  roomId: ROOM,
  from: role,
  ts: 0,
  payload: { role, deviceId },
});

const frame = (type: string, from: DeviceKind, payload: unknown) => ({
  type,
  roomId: ROOM,
  from,
  ts: 0,
  payload,
});

function connectedRoom() {
  const hub = makeHub();
  const desktop = new FakePeer();
  const mobile = new FakePeer();
  hub.handleMessage(desktop, reg('desktop', 'desktop-01'));
  hub.handleMessage(mobile, reg('mobile', 'mobile-01'));
  return { hub, desktop, mobile };
}

describe('SignalingHub — happy path', () => {
  it('runs pair → approve → offer/answer → ICE → disconnect', () => {
    const { hub, desktop, mobile } = connectedRoom();

    // mobile requests control → relayed to desktop
    hub.handleMessage(
      mobile,
      frame('pair-request', 'mobile', {
        deviceId: 'mobile-01',
        deviceName: 'phone',
        requestedScopes: ['view', 'control'],
      }),
    );
    expect(desktop.find('pair-request')).toBeTruthy();

    // desktop approves → both peers receive session-start with matching id + ICE
    hub.handleMessage(
      desktop,
      frame('pair-approved', 'desktop', { grantedScopes: ['view', 'control'] }),
    );
    const dStart = desktop.find('session-start');
    const mStart = mobile.find('session-start');
    expect(dStart?.payload.iceServers.length).toBeGreaterThan(0);
    expect(mStart?.payload.iceServers.length).toBeGreaterThan(0);
    expect(dStart?.payload.sessionId).toBe(mStart?.payload.sessionId);

    // offer (desktop) → mobile
    hub.handleMessage(desktop, frame('offer', 'desktop', { type: 'offer', sdp: 'v=0' }));
    expect(mobile.find('offer')?.payload.sdp).toBe('v=0');

    // answer (mobile) → desktop
    hub.handleMessage(mobile, frame('answer', 'mobile', { type: 'answer', sdp: 'v=0-ans' }));
    expect(desktop.find('answer')?.payload.sdp).toBe('v=0-ans');

    // trickle ICE both directions
    hub.handleMessage(desktop, frame('ice-candidate', 'desktop', { candidate: 'cand-d' }));
    expect(mobile.find('ice-candidate')).toBeTruthy();
    hub.handleMessage(mobile, frame('ice-candidate', 'mobile', { candidate: 'cand-m' }));
    expect(desktop.find('ice-candidate')).toBeTruthy();

    // disconnect tears the room down + closes the other peer
    hub.handleMessage(mobile, frame('disconnect', 'mobile', { reason: 'bye' }));
    expect(desktop.closed).toBeTruthy();
    expect(hub.roomCount()).toBe(0);
  });

  it('relays pause/resume and renegotiate', () => {
    const { hub, desktop, mobile } = connectedRoom();
    hub.handleMessage(desktop, frame('pair-approved', 'desktop', { grantedScopes: ['view'] }));
    hub.handleMessage(mobile, frame('pause', 'mobile', { reason: 'backgrounded' }));
    expect(desktop.find('pause')).toBeTruthy();
    hub.handleMessage(mobile, frame('resume', 'mobile', {}));
    expect(desktop.find('resume')).toBeTruthy();
    hub.handleMessage(mobile, frame('renegotiate', 'mobile', { iceRestart: true }));
    expect(desktop.find('renegotiate')).toBeTruthy();
  });

  it('answers ping with pong', () => {
    const { hub, mobile } = connectedRoom();
    hub.handleMessage(mobile, frame('ping', 'mobile', {}));
    expect(mobile.find('pong')).toBeTruthy();
  });
});

describe('SignalingHub — never trust the client', () => {
  it('rejects a first frame that is not register', () => {
    const hub = makeHub();
    const peer = new FakePeer();
    hub.handleMessage(peer, frame('offer', 'desktop', { type: 'offer', sdp: 'x' }));
    expect(peer.find('error')?.payload.code).toBe('not_registered');
  });

  it('rejects malformed frames', () => {
    const hub = makeHub();
    const peer = new FakePeer();
    hub.handleMessage(peer, { nonsense: true });
    expect(peer.find('error')?.payload.code).toBe('bad_message');
  });

  it('rejects a second peer taking an occupied seat', () => {
    const hub = makeHub();
    const a = new FakePeer();
    const b = new FakePeer();
    hub.handleMessage(a, reg('desktop', 'desktop-01'));
    hub.handleMessage(b, reg('desktop', 'desktop-02'));
    expect(b.find('error')?.payload.code).toBe('seat_taken');
    expect(b.closed).toBeTruthy();
  });

  it('blocks role spoofing (from must match the registered seat)', () => {
    const { hub, mobile } = connectedRoom();
    // mobile peer claims to be the desktop
    hub.handleMessage(mobile, frame('offer', 'desktop', { type: 'offer', sdp: 'x' }));
    expect(mobile.find('error')?.payload.code).toBe('role_mismatch');
  });

  it('forbids the mobile from approving its own pairing', () => {
    const { hub, mobile } = connectedRoom();
    hub.handleMessage(mobile, frame('pair-approved', 'mobile', { grantedScopes: ['control'] }));
    expect(mobile.find('error')?.payload.code).toBe('forbidden');
  });
});

describe('SignalingHub — heartbeat reaping', () => {
  it('reaps a peer that stops heart-beating', () => {
    let clock = 0;
    const hub = new SignalingHub({
      buildIceServers: () => ICE,
      now: () => clock,
      heartbeatTimeoutMs: 1000,
    });
    const desktop = new FakePeer();
    const mobile = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));
    hub.handleMessage(mobile, reg('mobile', 'mobile-01'));

    clock = 2000; // both now stale
    hub.reapStale();
    expect(desktop.closed?.reason).toBe('heartbeat timeout');
    expect(hub.roomCount()).toBe(0);
  });
});

describe('SignalingHub — mid-session reconnect grace', () => {
  /** Drive a room to `connected` (pair → approve → offer → answer). */
  function liveRoom(nowRef: { t: number }) {
    const hub = new SignalingHub({
      buildIceServers: () => ICE,
      now: () => nowRef.t,
      reregisterGraceMs: 15_000,
    });
    const desktop = new FakePeer();
    const mobile = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));
    hub.handleMessage(mobile, reg('mobile', 'mobile-01'));
    hub.handleMessage(
      mobile,
      frame('pair-request', 'mobile', {
        deviceId: 'mobile-01',
        deviceName: 'phone',
        requestedScopes: ['view'],
      }),
    );
    hub.handleMessage(desktop, frame('pair-approved', 'desktop', { grantedScopes: ['view'] }));
    hub.handleMessage(desktop, frame('offer', 'desktop', { type: 'offer', sdp: 'v=0' }));
    hub.handleMessage(mobile, frame('answer', 'mobile', { type: 'answer', sdp: 'v=0-ans' }));
    return { hub, desktop, mobile };
  }

  it('holds the seat on a mid-session drop and lets the same device re-register', () => {
    const nowRef = { t: 0 };
    const { hub, desktop, mobile } = liveRoom(nowRef);

    hub.handleClose(desktop); // transport drop, session stays alive
    expect(hub.roomCount()).toBe(1);
    expect(mobile.closed).toBeNull();

    // Same device re-registers within grace and routing works again.
    nowRef.t = 5_000;
    const desktop2 = new FakePeer();
    hub.handleMessage(desktop2, reg('desktop', 'desktop-01'));
    hub.handleMessage(desktop2, frame('offer', 'desktop', { type: 'offer', sdp: 'v=1' }));
    expect(mobile.find('offer')).toBeTruthy();
    expect(hub.roomCount()).toBe(1);
  });

  it('rejects a different device claiming the vacated seat', () => {
    const nowRef = { t: 0 };
    const { hub, desktop } = liveRoom(nowRef);
    hub.handleClose(desktop);

    expect(hub.roomCount()).toBe(1); // seat held, room alive

    const intruder = new FakePeer();
    hub.handleMessage(intruder, reg('desktop', 'evil-device-99'));
    expect(intruder.closed?.code).toBe(4409);
    expect(intruder.find('error')?.payload.code).toBe('seat_reserved');
    expect(hub.roomCount()).toBe(1); // room still waiting for the real device
  });

  it('keeps an established room alive past the grace while the other peer is present', () => {
    // Once established, a one-sided signaling drop must NOT end the session:
    // media + input flow peer-to-peer, so as long as the surviving peer is
    // connected the room persists (it ends only on explicit disconnect, or
    // once both peers are gone).
    const nowRef = { t: 0 };
    const { hub, desktop, mobile } = liveRoom(nowRef);
    hub.handleClose(desktop);

    nowRef.t = 15_001; // past the grace window
    hub.reapStale();
    expect(hub.roomCount()).toBe(1); // surviving mobile keeps the room alive
    expect(mobile.find('session-end')).toBeUndefined();
    expect(mobile.closed).toBeNull();
  });

  it('ends the room once BOTH peers are gone past the grace', () => {
    const nowRef = { t: 0 };
    const { hub, desktop, mobile } = liveRoom(nowRef);
    hub.handleClose(desktop);

    nowRef.t = 15_001; // past the grace window, mobile still present → room stays
    hub.reapStale();
    expect(hub.roomCount()).toBe(1);

    hub.handleClose(mobile); // now the surviving peer drops too → both gone
    expect(hub.roomCount()).toBe(0);
  });

  it('does not end the room synchronously when both seats vacate within milliseconds of each other', () => {
    // Regression test for the router-restart scenario (Finding 2,
    // docs/audit/m3/reconnect-lifecycle.md): both sockets die around the
    // same moment. The second handleClose must not read the first seat's
    // freshly-empty slot as "gone for good" — it just vacated too, and still
    // deserves its own grace window.
    const nowRef = { t: 0 };
    const { hub, desktop, mobile } = liveRoom(nowRef);

    hub.handleClose(desktop);
    nowRef.t = 5; // a few ms later, not 15s
    hub.handleClose(mobile);

    expect(hub.roomCount()).toBe(1); // held for grace, not torn down synchronously
    expect(desktop.closed).toBeNull();
    expect(mobile.closed).toBeNull();
  });

  it('reapStale ends a dual-vacated room once both grace windows elapse with no reconnect', () => {
    const nowRef = { t: 0 };
    const { hub, desktop, mobile } = liveRoom(nowRef);

    hub.handleClose(desktop);
    nowRef.t = 5;
    hub.handleClose(mobile);

    nowRef.t = 15_006; // both now past their own 15s grace
    hub.reapStale();

    expect(hub.roomCount()).toBe(0);
  });

  it('survives a near-simultaneous dual vacate if one device reconnects within grace', () => {
    const nowRef = { t: 0 };
    const { hub, desktop, mobile } = liveRoom(nowRef);

    hub.handleClose(desktop);
    nowRef.t = 5;
    hub.handleClose(mobile);

    nowRef.t = 3_000; // well within grace
    const desktop2 = new FakePeer();
    hub.handleMessage(desktop2, reg('desktop', 'desktop-01'));

    nowRef.t = 20_000; // past the ORIGINAL grace window, but desktop already reclaimed
    hub.reapStale();

    expect(hub.roomCount()).toBe(1);
  });

  it('still ends the room immediately when a peer drops before the session is live', () => {
    const hub = makeHub();
    const desktop = new FakePeer();
    const mobile = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));
    hub.handleMessage(mobile, reg('mobile', 'mobile-01'));

    hub.handleClose(mobile); // no live session yet — signaling IS the session
    expect(hub.roomCount()).toBe(0);
    expect(desktop.find('session-end')).toBeTruthy();
    expect(desktop.closed).toBeTruthy();
  });
});

describe('SignalingHub — abuse backstops', () => {
  it('reports registration state for the transport idle-close guard', () => {
    const hub = makeHub();
    const p = new FakePeer();
    expect(hub.isRegistered(p)).toBe(false);
    hub.handleMessage(p, reg('desktop', 'desktop-01'));
    expect(hub.isRegistered(p)).toBe(true);
    hub.handleClose(p);
    expect(hub.isRegistered(p)).toBe(false);
  });

  it('rejects new rooms past the room cap but still serves existing rooms', () => {
    const hub = new SignalingHub({ buildIceServers: () => ICE, now: () => 0, maxRooms: 1 });
    const a = new FakePeer();
    hub.handleMessage(a, { ...reg('desktop', 'desktop-01'), roomId: 'room-A' });
    expect(hub.roomCount()).toBe(1);

    // A second, new room is refused.
    const b = new FakePeer();
    hub.handleMessage(b, { ...reg('desktop', 'desktop-02'), roomId: 'room-B' });
    expect(b.find('error')?.payload.code).toBe('capacity');
    expect(b.closed?.code).toBe(4429);
    expect(hub.roomCount()).toBe(1);

    // The existing room still accepts its second seat (not a new room).
    const m = new FakePeer();
    hub.handleMessage(m, { ...reg('mobile', 'mobile-01'), roomId: 'room-A' });
    expect(m.closed).toBeNull();
    expect(hub.isRegistered(m)).toBe(true);
  });
});

describe('SignalingHub — graceful shutdown', () => {
  it('notifies every live peer with session-end and closes their sockets', () => {
    const { hub, desktop, mobile } = connectedRoom();
    hub.shutdownAll('server shutting down');
    expect(desktop.find('session-end')?.payload.reason).toBe('server shutting down');
    expect(mobile.find('session-end')?.payload.reason).toBe('server shutting down');
    expect(desktop.closed).toBeTruthy();
    expect(mobile.closed).toBeTruthy();
    expect(hub.roomCount()).toBe(0);
  });
});

describe('SignalingHub — never trust the client (additional paths)', () => {
  it('rejects a register whose payload.role does not match its own `from`', () => {
    // Distinct from the post-registration role_mismatch check in
    // handleMessage: this is register()'s own guard on the FIRST frame,
    // where `existing` is not set yet and the check is against the
    // register payload's own declared role, not a stored seat.
    const hub = makeHub();
    const peer = new FakePeer();
    hub.handleMessage(peer, {
      type: 'register',
      roomId: ROOM,
      from: 'desktop',
      ts: 0,
      payload: { role: 'mobile', deviceId: 'evil-desktop-01' },
    });
    expect(peer.find('error')?.payload.code).toBe('role_mismatch');
    expect(hub.isRegistered(peer)).toBe(false);
  });

  it("rejects a message whose roomId does not match the sender's registration", () => {
    const hub = makeHub();
    const peer = new FakePeer();
    hub.handleMessage(peer, reg('desktop', 'desktop-01'));
    hub.handleMessage(peer, frame('offer', 'desktop', { type: 'offer', sdp: 'x' }));
    // Same peer, but claims a different roomId than it registered under.
    hub.handleMessage(peer, {
      ...frame('offer', 'desktop', { type: 'offer', sdp: 'x' }),
      roomId: 'other-room',
    });
    expect(peer.find('error')?.payload.code).toBe('wrong_room');
  });

  it('rejects offer sent by a truthfully-registered mobile peer (wrong role, not spoofed identity)', () => {
    // Different from "blocks role spoofing": here `from` truthfully matches
    // the peer's own registration (mobile), so handleMessage's role check
    // passes — the rejection must come from dispatch's per-type requireRole
    // (defense in depth: your own seat still can't send the other role's
    // message types).
    const { hub, mobile } = connectedRoom();
    hub.handleMessage(mobile, frame('offer', 'mobile', { type: 'offer', sdp: 'x' }));
    expect(mobile.find('error')?.payload.code).toBe('forbidden');
  });

  it('rejects answer sent by a truthfully-registered desktop peer (wrong role)', () => {
    const { hub, desktop } = connectedRoom();
    hub.handleMessage(desktop, frame('answer', 'desktop', { type: 'answer', sdp: 'x' }));
    expect(desktop.find('error')?.payload.code).toBe('forbidden');
  });

  it('rejects server-originated message types sent by a client', () => {
    const { hub, desktop, mobile } = connectedRoom();
    hub.handleMessage(
      desktop,
      frame('session-start', 'desktop', {
        sessionId: 'sess-1',
        grantedScopes: ['view'],
        iceServers: [],
      }),
    );
    expect(desktop.find('error')?.payload.code).toBe('unexpected_type');
    hub.handleMessage(mobile, frame('pong', 'mobile', {}));
    expect(mobile.find('error')?.payload.code).toBe('unexpected_type');
  });
});

describe('SignalingHub — pair-denied', () => {
  it('relays denial to mobile and ends the room', () => {
    const { hub, desktop, mobile } = connectedRoom();
    hub.handleMessage(
      mobile,
      frame('pair-request', 'mobile', {
        deviceId: 'mobile-01',
        deviceName: 'phone',
        requestedScopes: ['view'],
      }),
    );
    hub.handleMessage(desktop, frame('pair-denied', 'desktop', { reason: 'not now' }));

    expect(mobile.find('pair-denied')?.payload.reason).toBe('not now');
    // The room ends immediately — no session-start was ever issued, so this
    // is the "signaling IS the session" teardown, not the peer-to-peer grace
    // path (there is no session-end reason grace here to mistake it for).
    expect(mobile.closed).toBeTruthy();
    expect(desktop.closed).toBeTruthy();
    expect(hub.roomCount()).toBe(0);
  });

  it('fires onPairDenied (not onSessionEnd) with room + device ids + reason (audit-log wiring seam)', () => {
    const denied: Array<{
      roomId: string;
      desktopDeviceId: string | null;
      mobileDeviceId: string | null;
      reason: string | null;
    }> = [];
    const sessionEnds: unknown[] = [];
    const hub = new SignalingHub({
      buildIceServers: () => ICE,
      now: () => 0,
      onPairDenied: (info) => denied.push(info),
      // No session was ever minted (no pair-approved), so this must stay
      // empty — proving `onPairDenied` was genuinely necessary rather than
      // redundant with the existing `onSessionEnd` hook.
      onSessionEnd: (sessionId, reason) => sessionEnds.push({ sessionId, reason }),
    });
    const desktop = new FakePeer();
    const mobile = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));
    hub.handleMessage(mobile, reg('mobile', 'mobile-01'));

    hub.handleMessage(
      mobile,
      frame('pair-request', 'mobile', {
        deviceId: 'mobile-01',
        deviceName: 'phone',
        requestedScopes: ['view'],
      }),
    );
    hub.handleMessage(desktop, frame('pair-denied', 'desktop', { reason: 'not now' }));

    expect(denied).toEqual([
      {
        roomId: ROOM,
        desktopDeviceId: 'desktop-01',
        mobileDeviceId: 'mobile-01',
        reason: 'not now',
      },
    ]);
    expect(sessionEnds).toEqual([]);
  });

  it('does NOT fire onPairDenied for a plain disconnect (only onSessionEnd territory)', () => {
    const denied: unknown[] = [];
    const hub = new SignalingHub({
      buildIceServers: () => ICE,
      now: () => 0,
      onPairDenied: (info) => denied.push(info),
    });
    const desktop = new FakePeer();
    const mobile = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));
    hub.handleMessage(mobile, reg('mobile', 'mobile-01'));

    hub.handleMessage(desktop, frame('disconnect', 'desktop', { reason: null }));

    expect(denied).toEqual([]);
  });
});

describe('SignalingHub — approve requires both seats', () => {
  it('rejects approval while the mobile seat is still empty', () => {
    const hub = makeHub();
    const desktop = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));

    hub.handleMessage(desktop, frame('pair-approved', 'desktop', { grantedScopes: ['view'] }));

    expect(desktop.find('error')?.payload.code).toBe('peer_missing');
    expect(desktop.find('session-start')).toBeUndefined();
  });
});

describe('SignalingHub — pairing before both seats exist', () => {
  it('drops a pair-request that arrives before the desktop ever registers', () => {
    // The mobile seat can register and send pair-request before the desktop
    // ever connects (e.g. a slow desktop launch after the phone scanned).
    // relay() has nowhere to deliver it — this pins the CURRENT behavior
    // (silently dropped, not queued or retried) rather than asserting it's
    // the ideal behavior; a fix would replay it once the desktop registers.
    const hub = makeHub();
    const mobile = new FakePeer();
    hub.handleMessage(mobile, reg('mobile', 'mobile-01'));
    hub.handleMessage(
      mobile,
      frame('pair-request', 'mobile', {
        deviceId: 'mobile-01',
        deviceName: 'phone',
        requestedScopes: ['view'],
      }),
    );
    // No error is sent to the mobile — the hub doesn't know the pair-request
    // failed to reach anyone; it's just silently absorbed.
    expect(mobile.find('error')).toBeUndefined();

    // When the desktop later registers, the lost pair-request is not replayed.
    const desktop = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));
    expect(desktop.find('pair-request')).toBeUndefined();
  });
});

describe('SignalingHub — metrics (additional counters)', () => {
  it('counts peersReaped on a heartbeat timeout', () => {
    let clock = 0;
    const hub = new SignalingHub({
      buildIceServers: () => ICE,
      now: () => clock,
      heartbeatTimeoutMs: 1000,
    });
    const desktop = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));

    expect(hub.metricsSnapshot().peersReaped).toBe(0);
    clock = 2000;
    hub.reapStale();
    expect(hub.metricsSnapshot().peersReaped).toBe(1);
  });

  it('counts roomsRejectedAtCapacity when a new room is refused', () => {
    const hub = new SignalingHub({ buildIceServers: () => ICE, now: () => 0, maxRooms: 1 });
    hub.handleMessage(new FakePeer(), { ...reg('desktop', 'desktop-01'), roomId: 'room-A' });
    expect(hub.metricsSnapshot().roomsRejectedAtCapacity).toBe(0);

    hub.handleMessage(new FakePeer(), { ...reg('desktop', 'desktop-02'), roomId: 'room-B' });
    expect(hub.metricsSnapshot().roomsRejectedAtCapacity).toBe(1);
  });
});

describe('SignalingHub — metrics', () => {
  it('counts sessions started/ended and exposes active rooms', () => {
    const { hub, desktop, mobile } = connectedRoom();
    let m = hub.metricsSnapshot();
    expect(m.activeRooms).toBe(1);
    expect(m.sessionsStarted).toBe(0);

    hub.handleMessage(
      mobile,
      frame('pair-request', 'mobile', {
        deviceId: 'mobile-01',
        deviceName: 'p',
        requestedScopes: ['view'],
      }),
    );
    hub.handleMessage(desktop, frame('pair-approved', 'desktop', { grantedScopes: ['view'] }));
    m = hub.metricsSnapshot();
    expect(m.sessionsStarted).toBe(1);

    hub.handleMessage(mobile, frame('disconnect', 'mobile', { reason: 'bye' }));
    m = hub.metricsSnapshot();
    expect(m.sessionsEnded).toBe(1);
    expect(m.activeRooms).toBe(0);
  });
});

describe('SignalingHub — Redis-backed room resurrection', () => {
  function liveRoomWithStore(nowRef: { t: number }, roomStore: RoomStore) {
    const hub = new SignalingHub({
      buildIceServers: () => ICE,
      now: () => nowRef.t,
      reregisterGraceMs: 15_000,
      roomStore,
    });
    const desktop = new FakePeer();
    const mobile = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));
    hub.handleMessage(mobile, reg('mobile', 'mobile-01'));
    hub.handleMessage(
      mobile,
      frame('pair-request', 'mobile', {
        deviceId: 'mobile-01',
        deviceName: 'phone',
        requestedScopes: ['view'],
      }),
    );
    hub.handleMessage(desktop, frame('pair-approved', 'desktop', { grantedScopes: ['view'] }));
    hub.handleMessage(desktop, frame('offer', 'desktop', { type: 'offer', sdp: 'v=0' }));
    hub.handleMessage(mobile, frame('answer', 'mobile', { type: 'answer', sdp: 'v=0-ans' }));
    return { hub, desktop, mobile };
  }

  it('persists established: true only once the answer lands, matching the live room', async () => {
    const nowRef = { t: 0 };
    const redis = new FakeRedis();
    const roomStore = new RoomStore(redis, 3600, () => nowRef.t);
    const hub = new SignalingHub({
      buildIceServers: () => ICE,
      now: () => nowRef.t,
      roomStore,
    });
    const desktop = new FakePeer();
    const mobile = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));
    hub.handleMessage(mobile, reg('mobile', 'mobile-01'));

    let [record] = await roomStore.loadAll();
    expect(record.established).toBe(false);

    hub.handleMessage(
      mobile,
      frame('pair-request', 'mobile', {
        deviceId: 'mobile-01',
        deviceName: 'phone',
        requestedScopes: ['view'],
      }),
    );
    hub.handleMessage(desktop, frame('pair-approved', 'desktop', { grantedScopes: ['view'] }));
    hub.handleMessage(desktop, frame('offer', 'desktop', { type: 'offer', sdp: 'v=0' }));
    hub.handleMessage(mobile, frame('answer', 'mobile', { type: 'answer', sdp: 'v=0-ans' }));

    [record] = await roomStore.loadAll();
    expect(record.established).toBe(true);
    expect(record.sessionId).toBeTruthy();
    expect(record.deviceIds).toEqual({ desktop: 'desktop-01', mobile: 'mobile-01' });
  });

  it('deletes the record once the room ends, so a restart does not resurrect a dead room', async () => {
    const nowRef = { t: 0 };
    const redis = new FakeRedis();
    const roomStore = new RoomStore(redis, 3600, () => nowRef.t);
    const { hub, mobile } = liveRoomWithStore(nowRef, roomStore);

    expect(await roomStore.loadAll()).toHaveLength(1);
    hub.handleMessage(mobile, frame('disconnect', 'mobile', { reason: 'bye' }));
    expect(await roomStore.loadAll()).toHaveLength(0);
  });

  it('resurrects an established room on a fresh hub instance sharing the same store, and both devices can reconnect and keep routing', async () => {
    const nowRef = { t: 0 };
    const redis = new FakeRedis();
    const roomStore = new RoomStore(redis, 3600, () => nowRef.t);

    // "Process A": drive a room to a live, established session.
    const { hub: hubA } = liveRoomWithStore(nowRef, roomStore);
    void hubA; // process A crashes here — never explicitly shut down

    // "Process B": a fresh hub, same Redis-backed store, simulating a
    // restart. Nothing in memory carries over except what resurrection reads
    // back.
    nowRef.t = 2_000;
    const hubB = new SignalingHub({
      buildIceServers: () => ICE,
      now: () => nowRef.t,
      reregisterGraceMs: 15_000,
      roomStore,
    });
    expect(hubB.roomCount()).toBe(0); // nothing yet — resurrection hasn't run

    const resurrectedCount = await hubB.resurrectRoomsFromStore();
    expect(resurrectedCount).toBe(1);
    expect(hubB.roomCount()).toBe(1);

    // Both original devices reconnect with fresh sockets (a real process
    // restart drops every WebSocket) — same deviceIds, so they reclaim their
    // seats exactly like a live mid-session grace-window reconnect.
    const desktop2 = new FakePeer();
    const mobile2 = new FakePeer();
    hubB.handleMessage(desktop2, reg('desktop', 'desktop-01'));
    hubB.handleMessage(mobile2, reg('mobile', 'mobile-01'));

    hubB.handleMessage(desktop2, frame('offer', 'desktop', { type: 'offer', sdp: 'v=1-restart' }));
    expect(mobile2.find('offer')?.payload.sdp).toBe('v=1-restart');
    expect(hubB.roomCount()).toBe(1);
  });

  it('rejects a different device from claiming a resurrected seat, same as a live vacate', async () => {
    const nowRef = { t: 0 };
    const redis = new FakeRedis();
    const roomStore = new RoomStore(redis, 3600, () => nowRef.t);
    liveRoomWithStore(nowRef, roomStore);

    nowRef.t = 2_000;
    const hubB = new SignalingHub({ buildIceServers: () => ICE, now: () => nowRef.t, roomStore });
    await hubB.resurrectRoomsFromStore();

    const intruder = new FakePeer();
    hubB.handleMessage(intruder, reg('desktop', 'evil-device-99'));
    expect(intruder.closed?.code).toBe(4409);
    expect(intruder.find('error')?.payload.code).toBe('seat_reserved');
  });

  it('does not resurrect a room whose persisted state is already terminal', async () => {
    const redis = new FakeRedis();
    const roomStore = new RoomStore(redis);
    await roomStore.save({
      id: 'stale-room',
      fsmState: 'disconnected',
      scopes: ['view'],
      deviceIds: { desktop: 'desktop-01' },
      established: true,
    });

    const hub = new SignalingHub({ buildIceServers: () => ICE, roomStore });
    const count = await hub.resurrectRoomsFromStore();

    expect(count).toBe(0);
    expect(hub.roomCount()).toBe(0);
  });

  it('resurrectRoomsFromStore is a no-op when no roomStore is configured', async () => {
    const hub = makeHub();
    expect(await hub.resurrectRoomsFromStore()).toBe(0);
  });

  it('register() still succeeds when the roomStore is unavailable — persistence is fire-and-forget, never on the hot path', async () => {
    // docs/audit/m3/testing-reliability.md Finding 5's third named test case:
    // a Redis outage during register/approve must degrade resurrection
    // capability only, never block or fail live signaling relay.
    class ThrowingRedis implements RoomKvStore {
      async get(): Promise<string | null> {
        throw new Error('redis unavailable');
      }
      async set(): Promise<unknown> {
        throw new Error('redis unavailable');
      }
      async del(): Promise<unknown> {
        throw new Error('redis unavailable');
      }
      async keys(): Promise<string[]> {
        throw new Error('redis unavailable');
      }
      async mget(): Promise<(string | null)[]> {
        throw new Error('redis unavailable');
      }
    }
    const roomStore = new RoomStore(new ThrowingRedis());
    const hub = new SignalingHub({ buildIceServers: () => ICE, roomStore });

    const desktop = new FakePeer();
    hub.handleMessage(desktop, reg('desktop', 'desktop-01'));

    // register() ran synchronously to completion despite the store rejecting
    // — no error surfaced to the peer, no throw escaped handleMessage.
    expect(desktop.closed).toBeNull();
    expect(desktop.find('error')).toBeUndefined();
    expect(hub.roomCount()).toBe(1);

    // Let the fire-and-forget persist promise's rejection settle so it
    // doesn't surface as an unhandled rejection in the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

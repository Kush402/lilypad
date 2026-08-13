import { describe, it, expect, vi } from 'vitest';
import { extractRegisterAttempt, decideRegisterGate } from './registerAuth.js';

const registerMsg = (role: string, deviceId: string, roomId = 'room-1') => ({
  type: 'register',
  roomId,
  from: role,
  ts: 0,
  payload: { role, deviceId },
});

const offerMsg = {
  type: 'offer',
  roomId: 'room-1',
  from: 'desktop',
  ts: 0,
  payload: { type: 'offer', sdp: 'v=0' },
};

describe('extractRegisterAttempt', () => {
  it('extracts roomId/role/deviceId from a well-shaped register message', () => {
    expect(
      extractRegisterAttempt({
        type: 'register',
        roomId: 'room-1',
        from: 'desktop',
        ts: 0,
        payload: { role: 'desktop', deviceId: 'desktop-01' },
      }),
    ).toEqual({ roomId: 'room-1', role: 'desktop', deviceId: 'desktop-01' });
  });

  it('returns null for a non-register message', () => {
    expect(
      extractRegisterAttempt({
        type: 'offer',
        roomId: 'room-1',
        from: 'desktop',
        ts: 0,
        payload: { type: 'offer', sdp: 'v=0' },
      }),
    ).toBeNull();
  });

  it.each([null, undefined, 'a string', 42, [], true])(
    'returns null for non-object input: %p',
    (input) => {
      expect(extractRegisterAttempt(input)).toBeNull();
    },
  );

  it('returns null when roomId is missing or not a string', () => {
    expect(
      extractRegisterAttempt({ type: 'register', payload: { role: 'desktop', deviceId: 'd-01' } }),
    ).toBeNull();
    expect(
      extractRegisterAttempt({
        type: 'register',
        roomId: 42,
        payload: { role: 'desktop', deviceId: 'd-01' },
      }),
    ).toBeNull();
  });

  it('returns null when payload is missing or not an object', () => {
    expect(extractRegisterAttempt({ type: 'register', roomId: 'room-1' })).toBeNull();
    expect(
      extractRegisterAttempt({ type: 'register', roomId: 'room-1', payload: 'nope' }),
    ).toBeNull();
    expect(
      extractRegisterAttempt({ type: 'register', roomId: 'room-1', payload: null }),
    ).toBeNull();
  });

  it('returns null when role is not exactly "desktop" or "mobile"', () => {
    expect(
      extractRegisterAttempt({
        type: 'register',
        roomId: 'room-1',
        payload: { role: 'admin', deviceId: 'd-01' },
      }),
    ).toBeNull();
  });

  it('returns null when deviceId is missing or not a string', () => {
    expect(
      extractRegisterAttempt({
        type: 'register',
        roomId: 'room-1',
        payload: { role: 'mobile' },
      }),
    ).toBeNull();
    expect(
      extractRegisterAttempt({
        type: 'register',
        roomId: 'room-1',
        payload: { role: 'mobile', deviceId: 12345 },
      }),
    ).toBeNull();
  });
});

/** The M9 presence-owner check, permissive — for the cases that never reach it. */
const ownerOk = () => vi.fn().mockResolvedValue(true);

describe('decideRegisterGate', () => {
  it('proceeds without calling verify for a non-register message', async () => {
    const verify = vi.fn();
    const decision = await decideRegisterGate(offerMsg, false, verify, ownerOk());
    expect(decision).toEqual({ action: 'proceed' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('proceeds without calling verify for ANY message once the peer is already registered', async () => {
    // Including one that looks like a register attempt — a duplicate
    // register from an already-seated peer is a harmless no-op the hub
    // handles itself; it must not be re-gated.
    const verify = vi.fn();
    const decision = await decideRegisterGate(
      registerMsg('desktop', 'desktop-01'),
      true,
      verify,
      ownerOk(),
    );
    expect(decision).toEqual({ action: 'proceed' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('proceeds when verify authorizes the attempt', async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const decision = await decideRegisterGate(
      registerMsg('desktop', 'desktop-01'),
      false,
      verify,
      ownerOk(),
    );
    expect(decision).toEqual({ action: 'proceed' });
    expect(verify).toHaveBeenCalledWith('room-1', 'desktop', 'desktop-01');
  });

  it('rejects with the attempt details when verify denies the attempt', async () => {
    const verify = vi.fn().mockResolvedValue(false);
    const decision = await decideRegisterGate(
      registerMsg('mobile', 'intruder-01'),
      false,
      verify,
      ownerOk(),
    );
    expect(decision).toEqual({
      action: 'reject_unauthorized',
      attempt: { roomId: 'room-1', role: 'mobile', deviceId: 'intruder-01' },
    });
  });

  it('maps a verify() rejection to a distinct "error" action, not "reject_unauthorized"', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('redis down'));
    const decision = await decideRegisterGate(
      registerMsg('desktop', 'desktop-01'),
      false,
      verify,
      ownerOk(),
    );
    expect(decision).toEqual({
      action: 'error',
      attempt: { roomId: 'room-1', role: 'desktop', deviceId: 'desktop-01' },
    });
  });

  it('proceeds for a malformed register-shaped message without ever calling verify', async () => {
    const verify = vi.fn();
    const decision = await decideRegisterGate(
      { type: 'register', roomId: 'room-1' },
      false,
      verify,
      ownerOk(),
    );
    expect(decision).toEqual({ action: 'proceed' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('never consults the presence-owner check for a session room', async () => {
    const verifyOwner = ownerOk();
    await decideRegisterGate(
      registerMsg('desktop', 'desktop-01'),
      false,
      vi.fn().mockResolvedValue(true),
      verifyOwner,
    );
    expect(verifyOwner).not.toHaveBeenCalled();
  });
});

describe('decideRegisterGate — presence rooms (M5.4, gated in M9)', () => {
  const presenceReg = (role: string, deviceId: string, roomId: string) =>
    registerMsg(role, deviceId, roomId);

  it('lets an authorized desktop claim ITS OWN presence room without touching room-auth', async () => {
    const verify = vi.fn();
    const decision = await decideRegisterGate(
      presenceReg('desktop', 'desktop-01', 'presence:desktop-01'),
      false,
      verify,
      ownerOk(),
    );
    expect(decision).toEqual({ action: 'proceed' });
    expect(verify).not.toHaveBeenCalled(); // presence never consults pairing records
  });

  it("rejects a desktop claiming ANOTHER device's presence room", async () => {
    const decision = await decideRegisterGate(
      presenceReg('desktop', 'intruder-99', 'presence:desktop-01'),
      false,
      vi.fn(),
      ownerOk(),
    );
    expect(decision.action).toBe('reject_unauthorized');
  });

  it('rejects a mobile registering into any presence room, even its own id', async () => {
    const decision = await decideRegisterGate(
      presenceReg('mobile', 'mobile-01', 'presence:mobile-01'),
      false,
      vi.fn(),
      ownerOk(),
    );
    expect(decision.action).toBe('reject_unauthorized');
  });

  it('rejects a degenerate presence room with a too-short owner suffix', async () => {
    const decision = await decideRegisterGate(
      presenceReg('desktop', 'short', 'presence:short'),
      false,
      vi.fn(),
      ownerOk(),
    );
    expect(decision.action).toBe('reject_unauthorized');
  });

  // SEC-4. Before M9 the suffix match WAS the whole gate, so this exact frame
  // — a correct self-claim, from a socket with no right to that device —
  // proceeded, took the presence seat, evicted the real laptop as a
  // "same-device reconnect", and received every ring meant for it.
  it('rejects a self-consistent claim when the socket does not own that device', async () => {
    const verifyOwner = vi.fn().mockResolvedValue(false);
    const decision = await decideRegisterGate(
      presenceReg('desktop', 'desktop-01', 'presence:desktop-01'),
      false,
      vi.fn(),
      verifyOwner,
    );
    expect(decision).toEqual({
      action: 'reject_unauthorized',
      attempt: { roomId: 'presence:desktop-01', role: 'desktop', deviceId: 'desktop-01' },
    });
    expect(verifyOwner).toHaveBeenCalledWith('desktop-01');
  });

  // Fails CLOSED: a database outage must not become an open presence lane.
  it('maps a presence-owner lookup failure to "error", never to proceed', async () => {
    const decision = await decideRegisterGate(
      presenceReg('desktop', 'desktop-01', 'presence:desktop-01'),
      false,
      vi.fn(),
      vi.fn().mockRejectedValue(new Error('postgres down')),
    );
    expect(decision).toEqual({
      action: 'error',
      attempt: { roomId: 'presence:desktop-01', role: 'desktop', deviceId: 'desktop-01' },
    });
  });

  // Shape first, identity second: a claim that is already malformed must not
  // cost a database round trip, or an anonymous socket could drive one per
  // frame.
  it('rejects a malformed presence claim without consulting the owner check', async () => {
    const verifyOwner = ownerOk();
    await decideRegisterGate(
      presenceReg('desktop', 'intruder-99', 'presence:desktop-01'),
      false,
      vi.fn(),
      verifyOwner,
    );
    expect(verifyOwner).not.toHaveBeenCalled();
  });
});

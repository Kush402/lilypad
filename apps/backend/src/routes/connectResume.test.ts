import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as AuthTokens from '../auth/tokens.js';

/**
 * `POST /connect/request` with `resume: true` reuses a live room instead of
 * minting one. Ring (`resume` absent) is unchanged — still a takeover.
 */

vi.mock('../auth/tokens.js', async () => {
  const actual = await vi.importActual<typeof AuthTokens>('../auth/tokens.js');
  return {
    ...actual,
    verifyAccessToken: vi.fn(async (token: string) =>
      token === 'phone-token' ? { userId: 'user-bob', deviceId: 'dev-phone' } : null,
    ),
  };
});

vi.mock('../auth/ownership.js', () => ({
  deviceOwnershipByFingerprint: vi.fn(),
  deviceOwnershipById: vi.fn(),
  pairOwnership: vi.fn(),
  ownsDevice: (userId: string, device: { userId: string | null } | null) =>
    device?.userId != null && device.userId === userId,
  canManagePair: vi.fn(),
}));

vi.mock('../auth/liveDevice.js', () => ({ rejectRevokedActor: vi.fn(async () => {}) }));

const { deviceOwnershipByFingerprint } = await import('../auth/ownership.js');
const { signalingRoutes } = await import('./signaling.js');

const PHONE = { deviceId: 'dev-phone', userId: 'user-bob', state: 'linked' as const };
const LAPTOP = { deviceId: 'dev-laptop', userId: 'user-bob', state: 'linked' as const };
const PAIR = { pairId: 'pair-1', autoApprove: false, displayName: 'MacBook' };

const authorizeConnect = vi.fn(async () => ({ ok: true, pair: PAIR }));
const isDesktopPresent = vi.fn(() => true);
const findLiveSessionForPair = vi.fn((): string | null => null);
const notifyConnectRequest = vi.fn(() => true);
const verify = vi.fn(async () => true);

function bundle() {
  return {
    hub: {
      isDesktopPresent,
      findLiveSessionForPair,
      notifyConnectRequest,
      resurrectRoomsFromStore: async () => 0,
      metricsSnapshot: () => ({}),
      reapStale: () => {},
      shutdownAll: () => {},
      isRegistered: () => false,
      hasLiveSession: () => false,
    },
    sessions: { sweepOrphaned: async () => 0 },
    roomAuth: {
      recordDesktop: vi.fn(async () => {}),
      recordMobile: vi.fn(async () => {}),
      verify,
    },
    trust: { authorizeConnect, touchConnected: vi.fn(async () => {}) },
  };
}

describe('POST /connect/request — resume a live session', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    authorizeConnect.mockResolvedValue({ ok: true, pair: PAIR });
    isDesktopPresent.mockReturnValue(true);
    findLiveSessionForPair.mockReturnValue(null);
    verify.mockResolvedValue(true);
    notifyConnectRequest.mockReturnValue(true);
    vi.mocked(deviceOwnershipByFingerprint).mockImplementation(async (kind: string) =>
      kind === 'mobile' ? PHONE : LAPTOP,
    );
    app = Fastify({ logger: false });
    await app.register(signalingRoutes, bundle() as never);
    await app.ready();
  });

  const post = (resume?: boolean) =>
    app.inject({
      method: 'POST',
      url: '/connect/request',
      headers: { authorization: 'Bearer phone-token' },
      payload: {
        desktopDeviceId: 'desktop-laptop-fingerprint',
        mobileDeviceId: 'mobile-phone-fingerprint',
        mobileDeviceName: 'a phone',
        pairSecret: 'a'.repeat(32),
        ...(resume ? { resume: true } : {}),
      },
    });

  it('reuses the live room and does not ring or mint', async () => {
    findLiveSessionForPair.mockReturnValue('live-room-id');
    const res = await post(true);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      roomId: 'live-room-id',
      resumed: true,
      desktopDeviceName: 'MacBook',
    });
    expect(notifyConnectRequest).not.toHaveBeenCalled();
  });

  it('answers 409 session_gone when there is no live room', async () => {
    findLiveSessionForPair.mockReturnValue(null);
    const res = await post(true);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('session_gone');
    expect(notifyConnectRequest).not.toHaveBeenCalled();
  });

  it('answers 409 when room-auth does not match this phone (unauthorized resume)', async () => {
    findLiveSessionForPair.mockReturnValue('live-room-id');
    verify.mockResolvedValue(false);
    const res = await post(true);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('session_gone');
    expect(notifyConnectRequest).not.toHaveBeenCalled();
  });

  it('a Ring without resume still mints and notifies (takeover)', async () => {
    findLiveSessionForPair.mockReturnValue('live-room-id');
    const res = await post(false);

    expect(res.statusCode).toBe(200);
    expect(res.json().resumed).toBeUndefined();
    expect(res.json().roomId).not.toBe('live-room-id');
    expect(notifyConnectRequest).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as AuthTokens from '../auth/tokens.js';

/**
 * Two accounts on one backend. Bob must not ring, resume, or join Alice.
 *
 * Pure-rule coverage lives in `auth/authorize.test.ts`. This file is the HTTP
 * half of M12's multi-user isolation case: a valid token for Bob still 404s
 * against Alice's laptop, same as an unknown pair.
 */

vi.mock('../auth/tokens.js', async () => {
  const actual = await vi.importActual<typeof AuthTokens>('../auth/tokens.js');
  return {
    ...actual,
    verifyAccessToken: vi.fn(async (token: string) => {
      if (token === 'alice-phone') return { userId: 'user-alice', deviceId: 'dev-alice-phone' };
      if (token === 'bob-phone') return { userId: 'user-bob', deviceId: 'dev-bob-phone' };
      return null;
    }),
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

const ALICE_PHONE = { deviceId: 'dev-alice-phone', userId: 'user-alice', state: 'linked' as const };
const ALICE_LAPTOP = {
  deviceId: 'dev-alice-laptop',
  userId: 'user-alice',
  state: 'linked' as const,
};
const BOB_PHONE = { deviceId: 'dev-bob-phone', userId: 'user-bob', state: 'linked' as const };
const BOB_LAPTOP = { deviceId: 'dev-bob-laptop', userId: 'user-bob', state: 'linked' as const };

const ALICE_PAIR = { pairId: 'pair-alice', autoApprove: false, displayName: "Alice's Mac" };
const BOB_PAIR = { pairId: 'pair-bob', autoApprove: false, displayName: "Bob's Mac" };

const ALICE_LAPTOP_FP = 'desktop-alice-mac';
const ALICE_PHONE_FP = 'mobile-alice-phone';
const BOB_LAPTOP_FP = 'desktop-bob-mac';
const BOB_PHONE_FP = 'mobile-bob-phone';
const SECRET = 'a'.repeat(32);

const authorizeConnect = vi.fn(
  async (desktop: string, mobile: string, secret: string | undefined) => {
    const matched =
      (desktop === ALICE_LAPTOP_FP && mobile === ALICE_PHONE_FP && secret === SECRET) ||
      (desktop === BOB_LAPTOP_FP && mobile === BOB_PHONE_FP && secret === SECRET);
    if (!matched) return { ok: false as const, reason: 'not_trusted' as const };
    return {
      ok: true as const,
      pair: desktop === ALICE_LAPTOP_FP ? ALICE_PAIR : BOB_PAIR,
    };
  },
);
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
      delete: vi.fn(async () => {}),
      verify,
    },
    trust: { authorizeConnect, touchConnected: vi.fn(async () => {}) },
  };
}

describe('POST /connect/request — two accounts cannot collide', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    isDesktopPresent.mockReturnValue(true);
    findLiveSessionForPair.mockReturnValue(null);
    verify.mockResolvedValue(true);
    notifyConnectRequest.mockReturnValue(true);
    vi.mocked(deviceOwnershipByFingerprint).mockImplementation(async (_kind, fingerprint) => {
      switch (fingerprint) {
        case ALICE_PHONE_FP:
          return ALICE_PHONE;
        case ALICE_LAPTOP_FP:
          return ALICE_LAPTOP;
        case BOB_PHONE_FP:
          return BOB_PHONE;
        case BOB_LAPTOP_FP:
          return BOB_LAPTOP;
        default:
          return null;
      }
    });
    app = Fastify({ logger: false });
    await app.register(signalingRoutes, bundle() as never);
    await app.ready();
  });

  const ring = (
    token: string,
    body: {
      desktopDeviceId: string;
      mobileDeviceId: string;
      resume?: boolean;
    },
  ) =>
    app.inject({
      method: 'POST',
      url: '/connect/request',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        mobileDeviceName: 'a phone',
        pairSecret: SECRET,
        ...body,
      },
    });

  it("lets Alice ring Alice's laptop", async () => {
    const res = await ring('alice-phone', {
      desktopDeviceId: ALICE_LAPTOP_FP,
      mobileDeviceId: ALICE_PHONE_FP,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().desktopDeviceName).toBe("Alice's Mac");
    expect(notifyConnectRequest).toHaveBeenCalledWith(
      ALICE_LAPTOP_FP,
      expect.objectContaining({ mobileDeviceId: ALICE_PHONE_FP }),
    );
  });

  it("lets Bob ring Bob's laptop on the same process", async () => {
    const res = await ring('bob-phone', {
      desktopDeviceId: BOB_LAPTOP_FP,
      mobileDeviceId: BOB_PHONE_FP,
    });
    expect(res.statusCode).toBe(200);
    expect(notifyConnectRequest).toHaveBeenCalledWith(
      BOB_LAPTOP_FP,
      expect.objectContaining({ mobileDeviceId: BOB_PHONE_FP }),
    );
  });

  it("refuses Bob acting as Alice's phone, even with a valid token", async () => {
    const res = await ring('bob-phone', {
      desktopDeviceId: ALICE_LAPTOP_FP,
      mobileDeviceId: ALICE_PHONE_FP,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_trusted');
    expect(authorizeConnect).not.toHaveBeenCalled();
    expect(notifyConnectRequest).not.toHaveBeenCalled();
  });

  it("refuses Bob ringing Alice's laptop with Bob's own phone", async () => {
    const res = await ring('bob-phone', {
      desktopDeviceId: ALICE_LAPTOP_FP,
      mobileDeviceId: BOB_PHONE_FP,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_trusted');
    expect(authorizeConnect).toHaveBeenCalledWith(ALICE_LAPTOP_FP, BOB_PHONE_FP, SECRET);
    expect(notifyConnectRequest).not.toHaveBeenCalled();
  });

  it("refuses Bob resuming Alice's live room even if the hub returned it", async () => {
    findLiveSessionForPair.mockReturnValue('room-alice');
    verify.mockResolvedValue(false);
    const res = await ring('bob-phone', {
      desktopDeviceId: BOB_LAPTOP_FP,
      mobileDeviceId: BOB_PHONE_FP,
      resume: true,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('session_gone');
    expect(notifyConnectRequest).not.toHaveBeenCalled();
  });
});

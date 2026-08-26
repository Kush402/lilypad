import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as AuthTokens from '../auth/tokens.js';

/**
 * Ringing a laptop that is no longer on the account.
 *
 * Signing out of a Mac releases it from the account
 * ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)), which
 * revokes the device row and leaves the `trusted_devices` rows alone. So this
 * is now an ordinary thing that happens to a working pair: the phone still
 * holds the laptop, still holds the per-pair secret, and gets refused.
 *
 * The refusal had two previous shapes and both misdirected. It fell through to
 * the presence check and answered `desktop_offline`, which sends the owner to
 * check a power cable for a machine sitting switched on in front of them; then
 * it answered the anonymous `not_trusted` 404, which sends them to a pairing
 * screen — and `/pairing/create` refuses a computer no account owns, so that
 * advice leads in a circle.
 *
 * **Why it may now say so.** The check moved to AFTER `authorizeConnect`. The
 * 404 existed so a caller guessing device ids could not learn which laptops
 * exist; past authorization there is nothing left to learn, because the caller
 * has proved it is the phone it names AND presented the per-pair connect
 * secret for this exact laptop.
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
const PAIR = { pairId: 'pair-1', autoApprove: false };

/** Authorized: the pair is real, unrevoked, and the secret matched. */
const authorizeConnect = vi.fn(async () => ({ ok: true, pair: PAIR }));
const isDesktopPresent = vi.fn(() => true);

function bundle() {
  return {
    hub: {
      isDesktopPresent,
      notifyConnectRequest: vi.fn(() => true),
      resurrectRoomsFromStore: async () => 0,
      metricsSnapshot: () => ({}),
      reapStale: () => {},
      shutdownAll: () => {},
      isRegistered: () => false,
      hasLiveSession: () => false,
    },
    sessions: { sweepOrphaned: async () => 0 },
    roomAuth: { recordDesktop: vi.fn(async () => {}), recordMobile: vi.fn(async () => {}) },
    trust: { authorizeConnect, touchConnected: vi.fn(async () => {}) },
  };
}

describe('POST /connect/request — a laptop that is not on the account', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    authorizeConnect.mockResolvedValue({ ok: true, pair: PAIR });
    isDesktopPresent.mockReturnValue(true);
    app = Fastify({ logger: false });
    await app.register(signalingRoutes, bundle() as never);
    await app.ready();
  });

  const ring = (headers: Record<string, string> = { authorization: 'Bearer phone-token' }) =>
    app.inject({
      method: 'POST',
      url: '/connect/request',
      headers,
      payload: {
        desktopDeviceId: 'desktop-laptop-fingerprint',
        mobileDeviceId: 'mobile-phone-fingerprint',
        mobileDeviceName: 'a phone',
        pairSecret: 'a'.repeat(32),
      },
    });

  const laptop = (state: 'linked' | 'revoked') =>
    vi
      .mocked(deviceOwnershipByFingerprint)
      .mockImplementation(async (kind: string) =>
        kind === 'mobile' ? PHONE : { deviceId: 'dev-laptop', userId: 'user-bob', state },
      );

  it('says it is not on the account, rather than that it is offline', async () => {
    laptop('revoked');
    const res = await ring();

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('desktop_not_on_account');
    expect(res.json().message).toMatch(/sign in to lilypad on it/i);
    // The wrong answer this replaces: presence is never even consulted, so
    // there is no path left on which this reports "offline".
    expect(isDesktopPresent).not.toHaveBeenCalled();
  });

  /** The 404 is still the answer for anyone who has not proved they hold this
   * pair — which is the enumeration protection the reorder had to preserve. */
  it('still refuses an unauthenticated caller anonymously', async () => {
    laptop('revoked');
    const res = await ring({});

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_trusted');
  });

  /** And a laptop that is simply asleep must keep saying so. */
  it('leaves an offline-but-owned laptop reported as offline', async () => {
    laptop('linked');
    isDesktopPresent.mockReturnValue(false);
    const res = await ring();

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('desktop_offline');
  });
});

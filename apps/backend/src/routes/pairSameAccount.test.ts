import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as AuthTokens from '../auth/tokens.js';

/**
 * A pair links two devices on the SAME account
 * ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)).
 *
 * Reachable only since ownership started following sign-in: before that a Mac
 * had no owner until a phone adopted it, so "two owners" could not arise from
 * the pairing ceremony. Now both machines join their own accounts on their own,
 * and two people signed into two accounts can stand in front of one screen.
 *
 * What the refusal prevents is a laptop that appears in one account's "Your
 * laptops" and no account's "Your devices" — listed in one place, unmanageable
 * from the other, revocable from neither.
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
  // Real, not a stub: the route reaches this route's guard only after
  // `actAsDevice` admits the phone, and a stubbed `ownsDevice` returns
  // undefined — every case would 404 at the gate and prove nothing.
  ownsDevice: (userId: string, device: { userId: string | null } | null) =>
    device?.userId != null && device.userId === userId,
  canManagePair: vi.fn(),
}));

vi.mock('../auth/liveDevice.js', () => ({ rejectRevokedActor: vi.fn(async () => {}) }));

const redeemPairing = vi.fn();
vi.mock('../services/pairing.js', () => ({
  createPairing: vi.fn(),
  redeemPairing: (...args: unknown[]) => redeemPairing(...args),
  PairingTokenError: class extends Error {},
}));

vi.mock('../services/auditLog.js', () => ({
  AuditLogService: class {
    devicePaired = vi.fn(async () => {});
  },
  createDrizzleAuditLogStore: vi.fn(),
}));

const { deviceOwnershipByFingerprint } = await import('../auth/ownership.js');
const { pairingRoutes } = await import('./pairing.js');

const owned = (deviceId: string, userId: string) => ({
  deviceId,
  userId,
  state: 'linked' as const,
});

const PHONE = owned('dev-phone', 'user-bob');
const REDEEMED = {
  roomId: '11111111-2222-4333-8444-555555555555',
  signalingUrl: 'wss://example.test/ws',
  scopes: ['view', 'control'],
  desktopDeviceName: 'Ada’s MacBook',
  desktopDeviceId: 'desktop-11111111-1111-4111-8111-111111111111',
};

describe('/pairing/redeem — a pair joins two devices on one account', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    redeemPairing.mockResolvedValue(REDEEMED);
    app = Fastify();
    await app.register(pairingRoutes);
    await app.ready();
  });

  const redeem = () =>
    app.inject({
      method: 'POST',
      url: '/pairing/redeem',
      headers: { authorization: 'Bearer phone-token' },
      payload: { token: 'x'.repeat(32), deviceId: 'mobile-1' },
    });

  /** Which fingerprint is asked about decides which of the two mocks answers,
   * so both resolutions are pinned rather than the resolver being a pass. */
  const ownership = (desktopOwner: string | null) =>
    (deviceOwnershipByFingerprint as ReturnType<typeof vi.fn>).mockImplementation(
      async (kind: string) =>
        kind === 'mobile'
          ? PHONE
          : desktopOwner === null
            ? null
            : owned('dev-laptop', desktopOwner),
    );

  it('refuses a laptop on someone else’s account', async () => {
    ownership('user-alice');
    const res = await redeem();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('different_account');
  });

  it('allows the same account', async () => {
    ownership('user-bob');
    const res = await redeem();
    expect(res.statusCode).toBe(200);
    expect(res.json().roomId).toBe(REDEEMED.roomId);
  });

  /** A laptop whose row cannot be resolved — deleted between minting the code
   * and scanning it. It must fall through to the ordinary path rather than be
   * reported as belonging to someone else, which would name an account that
   * does not exist as the reason. */
  it('does not claim a different account when the laptop row is gone', async () => {
    ownership(null);
    const res = await redeem();
    expect(res.statusCode).toBe(200);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Revoking a device has to end the credentials that could undo it.
 *
 * This is a regression test for a hole that was proven against production: a
 * revoked device could re-enrol its own unchanged keypair and come back. The
 * chain was `DELETE /devices/:id` leaves `refresh_tokens` alone -> the revoked
 * machine still holds an account session -> `POST /devices/enroll` ->
 * `DeviceRegistry.claim()` writes `revoked_at: null`. Every link was
 * individually reasonable; together they meant "I lost my laptop" did nothing
 * that lasted.
 *
 * `deviceRegistry.test.ts` covers `claim()` clearing revocation, which is the
 * legitimate way a user restores a device they got back. What was missing is
 * the assertion here: that by the time anyone can reach that path, the session
 * a thief would use to reach it is gone.
 */

vi.mock('../auth/ownership.js', () => ({
  deviceOwnershipByFingerprint: vi.fn(),
  deviceOwnershipById: vi.fn(),
  pairOwnership: vi.fn(),
  // The real rule, not a stub: `authorize.ts` calls this, and a mock that
  // always denied would make every test below pass for the wrong reason.
  ownsDevice: (userId: string, device: { userId: string | null }) => device.userId === userId,
  canManagePair: vi.fn(),
}));

const revokeUser = vi.fn(async () => {});
const revokeDevice = vi.fn(async () => ({ fingerprint: 'laptop-fingerprint' }));

vi.mock('../auth/refreshTokens.js', () => ({
  RefreshTokenService: class {
    revokeUser = revokeUser;
  },
  createDrizzleRefreshTokenStore: () => ({}),
}));

vi.mock('../services/accountDevices.js', () => ({
  AccountDeviceService: class {
    revoke = revokeDevice;
    list = async () => [];
    rename = async () => {};
  },
  createDrizzleAccountDeviceStore: () => ({}),
}));

vi.mock('../services/trust.js', () => ({
  TrustService: class {},
  createDrizzleTrustStore: () => ({}),
}));

vi.mock('../services/auditLog.js', () => ({
  AuditLogService: class {
    sessionEnd = async () => {};
  },
  createDrizzleAuditLogStore: () => ({}),
}));

const { deviceOwnershipById } = await import('../auth/ownership.js');
const { deviceRoutes } = await import('./devices.js');
const { signAccessToken } = await import('../auth/tokens.js');

const OWNER = 'user-alice';
const DEVICE_ID = '11111111-2222-4333-8444-555555555555';

/** The hub only has to answer the one call revoke makes. */
const hub = { endRoomsForDevice: vi.fn(() => 0) };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(deviceRoutes, { hub: hub as never });
  await app.ready();
  return app;
}

async function revoke(app: FastifyInstance, actor: { userId: string; deviceId: string }) {
  return app.inject({
    method: 'DELETE',
    url: `/devices/${DEVICE_ID}`,
    headers: { authorization: `Bearer ${await signAccessToken(actor)}` },
  });
}

describe('DELETE /devices/:deviceId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    revokeDevice.mockResolvedValue({ fingerprint: 'laptop-fingerprint' });
    vi.mocked(deviceOwnershipById).mockResolvedValue({
      deviceId: DEVICE_ID,
      userId: OWNER,
      state: 'linked',
    });
  });

  it('revokes every account session, so the revoked device cannot re-enrol itself', async () => {
    const app = await buildApp();
    const res = await revoke(app, { userId: OWNER, deviceId: 'dev-phone' });

    expect(res.statusCode).toBe(200);
    expect(revokeDevice).toHaveBeenCalledWith(DEVICE_ID);
    expect(revokeUser).toHaveBeenCalledWith(OWNER);
    await app.close();
  });

  it('ends the device live rooms as well as its sessions', async () => {
    const app = await buildApp();
    await revoke(app, { userId: OWNER, deviceId: 'dev-phone' });

    expect(hub.endRoomsForDevice).toHaveBeenCalledWith('laptop-fingerprint', 'revoked');
    await app.close();
  });

  it('answers 200 only after the sessions are actually gone', async () => {
    // Fire-and-forget would let the route report success while the credential
    // that undoes it is still live — the user would believe it worked.
    let settled = false;
    revokeUser.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 10));
      settled = true;
    });
    const app = await buildApp();
    const res = await revoke(app, { userId: OWNER, deviceId: 'dev-phone' });

    expect(res.statusCode).toBe(200);
    expect(settled).toBe(true);
    await app.close();
  });

  it('does not revoke sessions when the device was not found', async () => {
    // `null` means nothing was revoked. Signing the account out anyway would
    // turn a typo'd device id into a sign-out-everywhere.
    revokeDevice.mockResolvedValue(null as never);
    const app = await buildApp();
    const res = await revoke(app, { userId: OWNER, deviceId: 'dev-phone' });

    expect(res.statusCode).toBe(200);
    expect(revokeUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('a stranger cannot revoke a device, and so cannot sign its owner out', async () => {
    const app = await buildApp();
    const res = await revoke(app, { userId: 'user-mallory', deviceId: 'dev-mallory' });

    expect(res.statusCode).toBe(404);
    expect(revokeDevice).not.toHaveBeenCalled();
    expect(revokeUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('an account token is not enough — revoking needs a device', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/devices/${DEVICE_ID}`,
      headers: {
        authorization: `Bearer ${await signAccessToken({ userId: OWNER, deviceId: null })}`,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(revokeUser).not.toHaveBeenCalled();
    await app.close();
  });
});

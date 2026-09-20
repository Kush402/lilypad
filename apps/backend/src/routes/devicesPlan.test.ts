import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * `GET /devices` carries the account's hosted-Ask entitlement.
 *
 * The desktop holds a device token and no account session, so before this it
 * had no way to ask whether the account may run Ask on Lilypad's own model.
 * It offered the option to everyone and let the first task be refused — the
 * defect the owner hit on a real build.
 *
 * Two rules are pinned here. The answer comes from `hostedAskAccessFor`, the
 * same function the Ask route enforces with, so the screen and the gate cannot
 * drift (L-294/L-298 in another shape). And it is carried per caller, so
 * nothing about it is cached across accounts.
 */

vi.mock('../auth/ownership.js', () => ({
  deviceOwnershipByFingerprint: vi.fn(),
  // The caller is a live device of this account; `rejectRevokedActor` reads
  // it before the handler runs.
  deviceOwnershipById: vi.fn(async () => ({
    deviceId: 'dev-mac',
    userId: 'user-alice',
    state: 'linked',
  })),
  pairOwnership: vi.fn(),
  ownsDevice: (userId: string, device: { userId: string | null }) => device.userId === userId,
  canManagePair: vi.fn(),
}));

vi.mock('../auth/refreshTokens.js', () => ({
  RefreshTokenService: class {
    revokeUser = async () => {};
  },
  createDrizzleRefreshTokenStore: () => ({}),
}));

const listDevices = vi.fn(async () => [{ deviceId: 'dev-mac', kind: 'desktop', name: 'Mac' }]);

vi.mock('../services/accountDevices.js', () => ({
  AccountDeviceService: class {
    list = listDevices;
    revoke = async () => null;
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
    sessionsRevoked = async () => {};
  },
  createDrizzleAuditLogStore: () => ({}),
}));

const hostedAskAccessFor = vi.fn(async (_userId: string) => 'entitled' as string);

vi.mock('../services/entitlement.js', () => ({
  hostedAskAccessFor: (...args: unknown[]) => hostedAskAccessFor(...(args as [string])),
}));

const { deviceRoutes } = await import('./devices.js');
const { signAccessToken } = await import('../auth/tokens.js');

const OWNER = 'user-alice';

async function list(): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(deviceRoutes, { hub: { endRoomsForDevice: () => 0 } as never });
  await app.ready();
  const res = await app.inject({
    method: 'GET',
    url: '/devices',
    headers: {
      authorization: `Bearer ${await signAccessToken({ userId: OWNER, deviceId: 'dev-mac' })}`,
    },
  });
  await app.close();
  return { statusCode: res.statusCode, body: res.json() };
}

describe('GET /devices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDevices.mockResolvedValue([{ deviceId: 'dev-mac', kind: 'desktop', name: 'Mac' }]);
    hostedAskAccessFor.mockResolvedValue('entitled');
  });

  it('says whether this account may run Ask on Lilypad’s own model', async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.body.hostedAsk).toBe('entitled');
    expect(hostedAskAccessFor).toHaveBeenCalledWith(OWNER);
    // The device list is untouched by the addition.
    expect(Array.isArray(res.body.devices)).toBe(true);
  });

  it('carries a refusal as plainly as a grant', async () => {
    // A Free account must read as "not entitled", never as an absent field
    // the client could mistake for "yes" or for an old backend.
    hostedAskAccessFor.mockResolvedValue('not_entitled');
    const res = await list();
    expect(res.body.hostedAsk).toBe('not_entitled');
  });
});

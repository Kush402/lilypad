import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ConnectRequestSchema, DesktopEnrollmentApprovedSchema } from '@lilypad/protocol';
import type * as AuthTokens from '../auth/tokens.js';

/**
 * Approving a laptop must hand the phone an id the phone can actually ring.
 *
 * The regression this exists for was found in production. A device has two
 * ids — `devices.id`, an internal uuid, and `devices.fingerprint`, the wire id
 * every pair-scoped route resolves — and this route returned the first under a
 * field the phone stored as the second. `/connect/request` then looked up a
 * fingerprint that could not exist and answered `404 not_trusted`: "this
 * laptop hasn't trusted this phone yet", about a pairing that was live in the
 * database with a valid secret and no revocation. `/devices/unpair` failed the
 * same lookup and answered `200 ok` while severing nothing, so Forget reported
 * success and left the pairing alive.
 *
 * Nothing caught it because both ids are strings of similar length, the field
 * names differ by one word, and no test crossed the seam between the route
 * that mints the pair and the route that spends it.
 */

const APPROVER_DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const DESKTOP_DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const DESKTOP_FINGERPRINT = 'desktop-b31d4eed-d318-4e37-ba08-9a1f76349290';

vi.mock('../auth/tokens.js', async () => {
  const actual = await vi.importActual<typeof AuthTokens>('../auth/tokens.js');
  return {
    ...actual,
    verifyAccessToken: vi.fn(async (token: string) =>
      token === 'phone-token' ? { userId: 'user-alice', deviceId: APPROVER_DEVICE_ID } : null,
    ),
  };
});

vi.mock('../auth/liveDevice.js', () => ({ rejectRevokedActor: vi.fn(async () => {}) }));

vi.mock('../auth/desktopEnrollment.js', () => ({
  createDesktopEnrollmentCode: vi.fn(),
  consumeDesktopEnrollmentCode: vi.fn(async () => ({
    publicKey: 'k'.repeat(43),
    fingerprint: DESKTOP_FINGERPRINT,
    name: 'MacBook Pro',
    platform: 'macos' as const,
  })),
}));

const establishTrustForDeviceIds = vi.fn(async () => ({ pairSecret: 's'.repeat(32) }));

vi.mock('../services/trust.js', () => ({
  TrustService: class {
    establishTrustForDeviceIds = establishTrustForDeviceIds;
  },
  createDrizzleTrustStore: () => ({}),
}));

vi.mock('../auth/deviceRegistry.js', () => ({
  DeviceRegistry: class {
    enroll = vi.fn(async () => ({ ok: true as const, deviceId: DESKTOP_DEVICE_ID }));
  },
  createDrizzleDeviceIdentityStore: () => ({}),
}));

vi.mock('../services/auditLog.js', () => ({
  AuditLogService: class {
    login = async () => {};
    loginFailed = async () => {};
  },
  createDrizzleAuditLogStore: () => ({}),
}));

const { enrollmentRoutes } = await import('./enrollment.js');

describe('POST /devices/enrollment-code/approve', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(enrollmentRoutes);
    await app.ready();
  });

  const approve = () =>
    app.inject({
      method: 'POST',
      url: '/devices/enrollment-code/approve',
      headers: { authorization: 'Bearer phone-token' },
      payload: { code: 'c'.repeat(32) },
    });

  it('returns the wire id the phone must ring, not only the internal uuid', async () => {
    const res = await approve();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;

    // The exact swap that shipped: `desktopDeviceId` carrying `devices.id`.
    expect(body.desktopDeviceId).toBe(DESKTOP_FINGERPRINT);
    expect(body.desktopDeviceId).not.toBe(DESKTOP_DEVICE_ID);
    // …and the uuid still returned, under the name that means uuid.
    expect(body.deviceId).toBe(DESKTOP_DEVICE_ID);
  });

  it('hands the phone something /connect/request accepts unchanged', async () => {
    // The seam itself. A value that parses here and is rejected there is the
    // bug, whatever either side calls the field.
    const approved = DesktopEnrollmentApprovedSchema.parse(JSON.parse((await approve()).body));

    const connect = ConnectRequestSchema.safeParse({
      desktopDeviceId: approved.desktopDeviceId,
      mobileDeviceId: 'mobile-kqmqmoiq6vfff6e9msutl',
      pairSecret: approved.pairSecret,
    });

    expect(connect.success).toBe(true);
  });

  it('pairs the approving phone with the approved laptop, by row id', async () => {
    // Ownership and reachability are separate facts; the ceremony establishes
    // both, and it must use the uuids — the pair table's columns are uuids.
    await approve();
    expect(establishTrustForDeviceIds).toHaveBeenCalledWith(DESKTOP_DEVICE_ID, APPROVER_DEVICE_ID);
  });
});

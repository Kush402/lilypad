import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * The audit log has to be readable to be worth having.
 *
 * `/devices/token` is how a freshly installed desktop finds out it has been
 * linked — the approve route says so in as many words: "the desktop learns it
 * succeeded by its next /devices/token call starting to work". So the product
 * polls this endpoint, by design, from the moment it is installed until a
 * phone approves it, and every one of those polls answers
 * `403 device_not_enrolled`.
 *
 * Recording each as `login_failed` put 120 rows into production's audit log in
 * the three minutes of one customer's first run, all of them a machine
 * behaving correctly. The single event in this route that a human would ever
 * want to be told about — a revoked device presenting its key again — was
 * buried in them.
 */

const loginFailed = vi.fn(async () => {});
const authenticate = vi.fn();

vi.mock('../auth/deviceIdentity.js', () => ({
  createDeviceChallenge: vi.fn(),
  consumeDeviceChallenge: vi.fn(async () => 'ok'),
  verifyDeviceSignature: vi.fn(() => true),
}));

vi.mock('../auth/deviceRegistry.js', () => ({
  DeviceRegistry: class {
    authenticate = authenticate;
  },
  createDrizzleDeviceIdentityStore: () => ({}),
}));

vi.mock('../services/trust.js', () => ({
  TrustService: class {},
  createDrizzleTrustStore: () => ({}),
}));

vi.mock('../services/auditLog.js', () => ({
  AuditLogService: class {
    loginFailed = loginFailed;
    login = async () => {};
  },
  createDrizzleAuditLogStore: () => ({}),
}));

const { enrollmentRoutes } = await import('./enrollment.js');

describe('POST /devices/token', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(enrollmentRoutes);
    await app.ready();
  });

  const token = () =>
    app.inject({
      method: 'POST',
      url: '/devices/token',
      payload: {
        challenge: 'c'.repeat(32),
        publicKey: 'k'.repeat(43),
        signature: 's'.repeat(86),
      },
    });

  it('does not audit a laptop that simply has not been linked yet', async () => {
    authenticate.mockResolvedValue({ ok: false, reason: 'device_not_enrolled' });

    const res = await token();

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('device_not_enrolled');
    expect(loginFailed).not.toHaveBeenCalled();
  });

  it('audits a revoked device presenting its key again', async () => {
    authenticate.mockResolvedValue({ ok: false, reason: 'device_revoked' });

    const res = await token();

    expect(res.statusCode).toBe(403);
    expect(loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { reason: 'device_revoked' } }),
    );
  });
});

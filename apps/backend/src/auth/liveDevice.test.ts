import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * A revoked device must stop being a caller, not merely stop being a target.
 *
 * `authorize.test.ts` covers the target half — a revoked device is still
 * manageable by its owner, on purpose. This is the other question, and until it
 * was asked a device revoked one second ago kept every management route for the
 * remaining life of its access token. Verified against production before the
 * fix: `GET /devices`, `PATCH /devices/:id`, and the trusted-phones listing all
 * answered 200 for a phone that had just been revoked.
 */

vi.mock('./ownership.js', () => ({ deviceOwnershipById: vi.fn() }));

const { deviceOwnershipById } = await import('./ownership.js');
const { rejectRevokedActor } = await import('./liveDevice.js');
const { requireDevice, optionalAuth } = await import('./requireAuth.js');
const { signAccessToken } = await import('./tokens.js');

const DEVICE_ID = 'dev-phone';
const OWNER = 'user-alice';

async function buildApp(gate: 'device' | 'optional'): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get(
    '/probe',
    { preHandler: [gate === 'device' ? requireDevice : optionalAuth, rejectRevokedActor] },
    async () => ({ reached: true }),
  );
  await app.ready();
  return app;
}

const withToken = async (
  app: FastifyInstance,
  actor: { userId: string; deviceId: string | null },
) =>
  app.inject({
    method: 'GET',
    url: '/probe',
    headers: { authorization: `Bearer ${await signAccessToken(actor)}` },
  });

describe('rejectRevokedActor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('turns a revoked device away even with a still-valid token', async () => {
    vi.mocked(deviceOwnershipById).mockResolvedValue({
      deviceId: DEVICE_ID,
      userId: OWNER,
      state: 'revoked',
    });
    const app = await buildApp('device');
    const res = await withToken(app, { userId: OWNER, deviceId: DEVICE_ID });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'device_revoked' });
    await app.close();
  });

  it('lets a live device through', async () => {
    vi.mocked(deviceOwnershipById).mockResolvedValue({
      deviceId: DEVICE_ID,
      userId: OWNER,
      state: 'linked',
    });
    const app = await buildApp('device');
    const res = await withToken(app, { userId: OWNER, deviceId: DEVICE_ID });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('turns away a token naming a device that no longer exists', async () => {
    // Deleting an account cascades its devices. The token outlives the row.
    vi.mocked(deviceOwnershipById).mockResolvedValue(null);
    const app = await buildApp('device');
    const res = await withToken(app, { userId: OWNER, deviceId: DEVICE_ID });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('does not touch the database for an account token', async () => {
    // Account sessions have no device to revoke, and these routes are on the
    // path of every device list refresh — no lookup where there is no question.
    const app = await buildApp('optional');
    const res = await withToken(app, { userId: OWNER, deviceId: null });

    expect(res.statusCode).toBe(200);
    expect(deviceOwnershipById).not.toHaveBeenCalled();
    await app.close();
  });

  it('leaves the unauthenticated lane alone', async () => {
    // `optionalAuth` routes still serve devices no account owns. There is no
    // actor, so there is nothing to have been revoked.
    const app = await buildApp('optional');
    const res = await app.inject({ method: 'GET', url: '/probe' });

    expect(res.statusCode).toBe(200);
    expect(deviceOwnershipById).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not answer twice when an earlier gate already refused', async () => {
    // `requireDevice` 401s an account token. Sending a second reply on the same
    // request throws inside Fastify, which would turn a clean 403 into a 500.
    const app = await buildApp('device');
    const res = await withToken(app, { userId: OWNER, deviceId: null });

    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

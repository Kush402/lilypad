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

vi.mock('./ownership.js', () => ({ deviceOwnershipById: vi.fn(), accountExists: vi.fn() }));

const { deviceOwnershipById, accountExists } = await import('./ownership.js');
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
  beforeEach(() => {
    vi.clearAllMocks();
    // The ordinary case: the account behind the token is still there.
    vi.mocked(accountExists).mockResolvedValue(true);
  });

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

  it('does not look up a device for an account token', async () => {
    // Account sessions have no device to revoke, and these routes are on the
    // path of every device list refresh — no device lookup where there is no
    // device. The account itself is still checked, which is one indexed read
    // on the primary key and the only thing that can disqualify this caller.
    const app = await buildApp('optional');
    const res = await withToken(app, { userId: OWNER, deviceId: null });

    expect(res.statusCode).toBe(200);
    expect(deviceOwnershipById).not.toHaveBeenCalled();
    expect(accountExists).toHaveBeenCalledWith(OWNER);
    await app.close();
  });

  it('turns away an account token whose account has been deleted', async () => {
    // `DELETE /account` cannot invalidate a signed token, so this is what makes
    // deletion take effect now rather than in up to ten minutes. Without it the
    // caller's own token still reached `POST /devices/enroll`, which would try
    // to write a `user_id` no `users` row matches.
    vi.mocked(accountExists).mockResolvedValue(false);
    const app = await buildApp('optional');
    const res = await withToken(app, { userId: OWNER, deviceId: null });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
    await app.close();
  });

  it('checks the device, not the account, when the token names a device', async () => {
    // `devices.user_id` is a foreign key: a device row that exists proves its
    // owner does. A second read would buy nothing on the hot path.
    vi.mocked(deviceOwnershipById).mockResolvedValue({
      deviceId: DEVICE_ID,
      userId: OWNER,
      state: 'linked',
    });
    const app = await buildApp('device');
    const res = await withToken(app, { userId: OWNER, deviceId: DEVICE_ID });

    expect(res.statusCode).toBe(200);
    expect(accountExists).not.toHaveBeenCalled();
    await app.close();
  });

  it('leaves the unauthenticated lane alone', async () => {
    // `optionalAuth` routes still serve devices no account owns. There is no
    // actor, so there is nothing to have been revoked — and nothing to look up.
    const app = await buildApp('optional');
    const res = await app.inject({ method: 'GET', url: '/probe' });

    expect(res.statusCode).toBe(200);
    expect(deviceOwnershipById).not.toHaveBeenCalled();
    expect(accountExists).not.toHaveBeenCalled();
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

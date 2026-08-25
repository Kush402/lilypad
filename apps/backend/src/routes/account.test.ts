import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as AccountDeletion from '../services/accountDeletion.js';

/**
 * `DELETE /account` — the route a product that stores someone's machines has
 * to have, and that Lilypad shipped without.
 *
 * What is being defended here is not confidentiality but irreversibility. This
 * is the only call in the product that destroys data, so the tests are about
 * the ways it could destroy the WRONG data, or claim to have destroyed data it
 * did not: a caller with no token, a caller with a revoked device, a
 * confirmation that does not name this account, and a success that leaves the
 * user's live sessions running.
 */

const accountEmail = vi.fn();
const purgeAccount = vi.fn();

vi.mock('../services/accountDeletion.js', async (importOriginal) => {
  // `confirmsDeletion` is the real one on purpose. Stubbing the comparison
  // would make the mismatch test pass without ever testing the comparison.
  const actual = await importOriginal<typeof AccountDeletion>();
  return { ...actual, accountEmail, purgeAccount };
});

const accountExists = vi.fn(async () => true);
vi.mock('../auth/ownership.js', () => ({
  accountExists,
  deviceOwnershipById: vi.fn(),
}));

const sessionsRevoked = vi.fn(async () => {});
vi.mock('../services/auditLog.js', () => ({
  AuditLogService: class {
    sessionsRevoked = sessionsRevoked;
  },
  createDrizzleAuditLogStore: () => ({}),
}));

const { accountRoutes } = await import('./account.js');
const { signAccessToken } = await import('../auth/tokens.js');
const { deviceOwnershipById } = await import('../auth/ownership.js');

const OWNER = 'user-alice';
const EMAIL = 'alice@example.com';

const hub = { endRoomsForDevice: vi.fn(() => 1) };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(accountRoutes, { hub: hub as never });
  await app.ready();
  return app;
}

async function del(
  app: FastifyInstance,
  body: unknown,
  actor: { userId: string; deviceId: string | null } | null = { userId: OWNER, deviceId: null },
) {
  return app.inject({
    method: 'DELETE',
    url: '/account',
    payload: body,
    headers: actor ? { authorization: `Bearer ${await signAccessToken(actor)}` } : {},
  });
}

describe('DELETE /account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountExists.mockResolvedValue(true);
    // The default for the device-token cases below: a device still on the
    // account. Individual tests override it.
    vi.mocked(deviceOwnershipById).mockResolvedValue({
      deviceId: 'dev-mac',
      userId: OWNER,
      state: 'linked',
    });
    accountEmail.mockResolvedValue(EMAIL);
    purgeAccount.mockResolvedValue(['mac-01', 'phone-01']);
    hub.endRoomsForDevice.mockReturnValue(1);
  });

  it('deletes the account when the caller confirms its address', async () => {
    const app = await buildApp();
    const res = await del(app, { confirmEmail: EMAIL });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, devicesRemoved: 2 });
    expect(purgeAccount).toHaveBeenCalledWith(OWNER);
    await app.close();
  });

  it('deletes the account the TOKEN names, never one from the body', async () => {
    // The confirmation is an accident guard, not a selector. If it were ever
    // used to look the account up, typing someone else's address would delete
    // their account.
    const app = await buildApp();
    await del(app, { confirmEmail: EMAIL }, { userId: OWNER, deviceId: 'dev-mac' });

    expect(accountEmail).toHaveBeenCalledWith(OWNER);
    expect(purgeAccount).toHaveBeenCalledWith(OWNER);
    await app.close();
  });

  it('refuses an unauthenticated caller', async () => {
    const app = await buildApp();
    const res = await del(app, { confirmEmail: EMAIL }, null);

    expect(res.statusCode).toBe(401);
    expect(purgeAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a forged token', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/account',
      payload: { confirmEmail: EMAIL },
      headers: { authorization: 'Bearer not.a.real.token' },
    });

    expect(res.statusCode).toBe(401);
    expect(purgeAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a device that was removed from the account', async () => {
    // A stolen laptop, already revoked, must not be able to delete the account
    // it was revoked from — that would turn revocation into a way to retaliate.
    vi.mocked(deviceOwnershipById).mockResolvedValue({
      deviceId: 'dev-mac',
      userId: OWNER,
      state: 'revoked',
    });
    const app = await buildApp();
    const res = await del(app, { confirmEmail: EMAIL }, { userId: OWNER, deviceId: 'dev-mac' });

    expect(res.statusCode).toBe(401);
    expect(purgeAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a token for an account that is already gone', async () => {
    accountExists.mockResolvedValue(false);
    const app = await buildApp();
    const res = await del(app, { confirmEmail: EMAIL });

    expect(res.statusCode).toBe(401);
    expect(purgeAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a confirmation that names a different account', async () => {
    const app = await buildApp();
    const res = await del(app, { confirmEmail: 'someone@else.com' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'confirmation_mismatch' });
    expect(purgeAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a request with no confirmation at all', async () => {
    const app = await buildApp();
    const res = await del(app, {});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
    expect(purgeAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it('ends every live session belonging to the deleted devices', async () => {
    // Without this the account is gone from the database while a phone keeps
    // watching a screen — the delete would be true and useless at once.
    const app = await buildApp();
    await del(app, { confirmEmail: EMAIL });

    expect(hub.endRoomsForDevice).toHaveBeenCalledWith('mac-01', 'revoked');
    expect(hub.endRoomsForDevice).toHaveBeenCalledWith('phone-01', 'revoked');
    await app.close();
  });

  it('disconnects only after the delete has actually committed', async () => {
    // Cutting the session first would tell the user their account was gone
    // before the database agreed.
    const order: string[] = [];
    purgeAccount.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('purged');
      return ['mac-01'];
    });
    hub.endRoomsForDevice.mockImplementation(() => {
      order.push('disconnected');
      return 1;
    });
    const app = await buildApp();
    await del(app, { confirmEmail: EMAIL });

    expect(order).toEqual(['purged', 'disconnected']);
    await app.close();
  });

  it('records the deletion without re-recording who it was', async () => {
    // The audit row outlives the account by up to the 2-day retention window.
    // Writing the address or the user id back into it would re-create the one
    // piece of personal data the delete just removed.
    const app = await buildApp();
    await del(app, { confirmEmail: EMAIL });

    expect(sessionsRevoked).toHaveBeenCalledTimes(1);
    const fields = sessionsRevoked.mock.calls[0]?.[0] as { userId?: unknown; metadata: unknown };
    expect(fields.userId).toBeUndefined();
    expect(fields.metadata).toMatchObject({ event: 'account_deleted', devicesRemoved: 2 });
    expect(JSON.stringify(fields)).not.toContain(EMAIL);
    expect(JSON.stringify(fields)).not.toContain(OWNER);
    await app.close();
  });

  it('answers 404 when the account vanished between the read and the delete', async () => {
    purgeAccount.mockResolvedValue(null);
    const app = await buildApp();
    const res = await del(app, { confirmEmail: EMAIL });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('answers 404, not 500, when the token names an account that is not there', async () => {
    accountEmail.mockResolvedValue(null);
    const app = await buildApp();
    const res = await del(app, { confirmEmail: EMAIL });

    expect(res.statusCode).toBe(404);
    expect(purgeAccount).not.toHaveBeenCalled();
    await app.close();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Two things a sign-in route must do that no service test can prove, because
 * both are decisions the ROUTE makes after its services have returned:
 *
 * 1. **A password reset ends every session that existed before it.** Reset is
 *    what a compromised user is told to do; if the attacker's refresh token
 *    survives it, the one remediation the product offers does nothing.
 * 2. **Proving an inbox that a squatter had registered revokes the squatter's
 *    sessions.** `accounts.test.ts` proves the password is dropped; only the
 *    route can drop the sessions that password had already opened.
 */

const revokeUser = vi.fn(async () => {});
const issue = vi.fn(async () => ({ token: 'refresh-new', id: 'r1', userId: 'u1' }));
const setPasswordForEmail = vi.fn<(email: string, pw: string) => Promise<string | null>>();
const resolveEmail =
  vi.fn<(email: string) => Promise<{ userId: string; claimedFromUnproven: boolean }>>();
const redeemPasswordReset = vi.fn<(token: string) => Promise<string | null>>();
const redeemMagicLink = vi.fn<(token: string) => Promise<string | null>>();

vi.mock('../auth/refreshTokens.js', () => ({
  RefreshTokenService: class {
    revokeUser = revokeUser;
    issue = issue;
    rotate = vi.fn();
  },
  createDrizzleRefreshTokenStore: () => ({}),
}));
vi.mock('../auth/accounts.js', () => ({
  AccountService: class {
    setPasswordForEmail = setPasswordForEmail;
    resolveEmail = resolveEmail;
    resolveProviderIdentity = vi.fn();
    verifyPasswordSignIn = vi.fn();
    signUpWithPassword = vi.fn();
  },
  createDrizzleAccountStore: () => ({}),
}));
vi.mock('../auth/magicLink.js', () => ({
  createMagicLink: vi.fn(),
  redeemMagicLink,
  createPasswordReset: vi.fn(),
  redeemPasswordReset,
  createMailSender: () => null,
}));
vi.mock('../auth/tokens.js', () => ({
  signAccessToken: async () => 'access-new',
  ACCESS_TOKEN_TTL_SECONDS: 600,
}));
vi.mock('../services/auditLog.js', () => ({
  AuditLogService: class {
    login = vi.fn(async () => {});
    loginFailed = vi.fn(async () => {});
    sessionsRevoked = vi.fn(async () => {});
  },
  createDrizzleAuditLogStore: () => ({}),
}));

const { authRoutes } = await import('./auth.js');

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  app = Fastify();
  await app.register(authRoutes);
  await app.ready();
});

describe('POST /auth/password/reset/confirm', () => {
  it('revokes every pre-existing session, so a stolen refresh token dies with the reset', async () => {
    redeemPasswordReset.mockResolvedValue('ada@example.com');
    setPasswordForEmail.mockResolvedValue('user-ada');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/password/reset/confirm',
      payload: { token: 'a'.repeat(32), password: 'a brand new passphrase' },
    });

    expect(res.statusCode).toBe(200);
    expect(revokeUser).toHaveBeenCalledWith('user-ada');
    // ...and the session this request hands back is minted AFTER the revoke,
    // or the user would be signed out by their own password reset.
    expect(revokeUser.mock.invocationCallOrder[0]).toBeLessThan(issue.mock.invocationCallOrder[0]);
  });

  it('revokes nothing when the token does not redeem', async () => {
    redeemPasswordReset.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password/reset/confirm',
      payload: { token: 'a'.repeat(32), password: 'a brand new passphrase' },
    });
    expect(res.statusCode).toBe(401);
    expect(revokeUser).not.toHaveBeenCalled();
  });
});

describe('POST /auth/magic-link/verify', () => {
  it('revokes the squatter’s sessions when it claims an unproven account', async () => {
    redeemMagicLink.mockResolvedValue('ada@example.com');
    resolveEmail.mockResolvedValue({ userId: 'user-ada', claimedFromUnproven: true });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/verify',
      payload: { token: 'a'.repeat(32) },
    });

    expect(res.statusCode).toBe(200);
    expect(revokeUser).toHaveBeenCalledWith('user-ada');
  });

  it('leaves an ordinary sign-in’s other sessions alone', async () => {
    redeemMagicLink.mockResolvedValue('ada@example.com');
    resolveEmail.mockResolvedValue({ userId: 'user-ada', claimedFromUnproven: false });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/verify',
      payload: { token: 'a'.repeat(32) },
    });

    expect(res.statusCode).toBe(200);
    expect(revokeUser).not.toHaveBeenCalled();
  });
});

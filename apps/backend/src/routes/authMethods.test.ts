import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

/**
 * `GET /auth/methods` — which ways in this server can actually perform.
 *
 * It exists because production could not perform two of the ones the phone
 * offered. There has never been a `RESEND_API_KEY` on the box, so
 * `POST /auth/magic-link/request` and the password-reset pair answered 503 on
 * every call, and no Google client is configured either — yet "Email me a
 * sign-in link" and "Forgot your password?" sat on the first screen of the
 * app, indistinguishable from the ones that work.
 *
 * The rule these pin: availability is reported from the SAME configuration the
 * routes themselves branch on, so the answer cannot drift away from what the
 * server will really do.
 */

const isProviderConfigured = vi.fn((p: string) => p === 'apple');
const createMailSender = vi.fn<() => object | null>(() => null);

vi.mock('../auth/providers.js', () => ({ isProviderConfigured, verifyProviderToken: vi.fn() }));
vi.mock('../auth/magicLink.js', () => ({
  createMailSender,
  createMagicLink: vi.fn(),
  redeemMagicLink: vi.fn(),
  createPasswordReset: vi.fn(),
  redeemPasswordReset: vi.fn(),
}));
vi.mock('../auth/tokens.js', () => ({ signAccessToken: vi.fn(), ACCESS_TOKEN_TTL_SECONDS: 600 }));
vi.mock('../auth/refreshTokens.js', () => ({
  RefreshTokenService: class {},
  createDrizzleRefreshTokenStore: () => ({}),
}));
vi.mock('../auth/accounts.js', () => ({
  AccountService: class {},
  createDrizzleAccountStore: () => ({}),
}));
vi.mock('../services/auditLog.js', () => ({
  AuditLogService: class {},
  createDrizzleAuditLogStore: () => ({}),
}));

async function methods() {
  vi.resetModules();
  const { authRoutes } = await import('./auth.js');
  const app = Fastify();
  await app.register(authRoutes);
  const res = await app.inject({ method: 'GET', url: '/auth/methods' });
  await app.close();
  return res;
}

describe('GET /auth/methods', () => {
  it('reports email as unavailable when no mail sender is configured', async () => {
    createMailSender.mockReturnValue(null);
    const res = await methods();
    expect(res.statusCode).toBe(200);
    // This is production's answer today. A client that hides its email flows
    // on it stops offering a button whose only outcome is a 503.
    expect(res.json()).toEqual({ email: false, apple: true, google: false });
  });

  it('reports email as available the moment a sender exists', async () => {
    // No redeploy of the clients, no flag to flip: setting the key is the
    // whole change, and the sign-in screen grows its email flows back.
    createMailSender.mockReturnValue({ sendMagicLink: vi.fn(), sendPasswordReset: vi.fn() });
    expect((await methods()).json().email).toBe(true);
  });

  it('answers without a token, because a client needs it before it has one', async () => {
    // Not a test of a happy path — a test that no preHandler gets added here
    // later. A 401 would make the screen fall back to showing everything,
    // which is exactly the state this endpoint was written to end.
    createMailSender.mockReturnValue(null);
    expect((await methods()).statusCode).toBe(200);
  });
});

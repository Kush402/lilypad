import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as AuthTokens from '../auth/tokens.js';

// Only the token check is faked, so `requireAuth` admits the request and the
// handler's own logic is what decides. Everything past the guard — Redis for
// the challenge, Postgres for the device row — is deliberately never reached:
// a refusal that touched them would be proving less, not more.
vi.mock('../auth/tokens.js', async () => {
  const actual = await vi.importActual<typeof AuthTokens>('../auth/tokens.js');
  return {
    ...actual,
    verifyAccessToken: vi.fn(async (token: string) =>
      token === 'account-token' ? { userId: 'user-alice', deviceId: null } : null,
    ),
  };
});

// The proof check is the FIRST thing past the guard, and it is backed by
// Redis. Stubbing it keeps this file infrastructure-free and makes the
// "mobile gets past the guard" case observable: it fails here instead.
vi.mock('../auth/deviceIdentity.js', () => ({
  createDeviceChallenge: vi.fn(),
  consumeDeviceChallenge: vi.fn(async () => null),
  verifyDeviceSignature: vi.fn(() => false),
}));

// `rejectRevokedActor` runs ahead of the handler now: a deleted account must
// not be able to enrol a device onto itself. Stubbed to "the account is still
// there" so this file keeps testing the linking rule rather than the gate —
// `liveDevice.test.ts` owns the gate.
vi.mock('../auth/ownership.js', () => ({
  accountExists: vi.fn(async () => true),
  deviceOwnershipById: vi.fn(async () => null),
  deviceOwnershipByFingerprint: vi.fn(async () => null),
  pairOwnership: vi.fn(async () => null),
  ownsDevice: vi.fn(() => false),
  canManagePair: vi.fn(() => false),
}));

const { enrollmentRoutes } = await import('./enrollment.js');

/**
 * Signing in on a machine is what puts it on the account — on every platform
 * ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)).
 *
 * This file used to assert the opposite: a `403
 * desktop_enrollment_requires_approval` for `kind: "desktop"`. The refusal was
 * removed because it withheld nothing — the capability behind it is a device
 * token, and the same account password mints one through this same route with
 * `kind: "mobile"` — while making ownership mean one thing on a phone and
 * another on a Mac.
 *
 * What the tests below pin is that removing it did not weaken the route: a
 * token is still required, and both kinds are now treated identically, failing
 * together at the proof they cannot forge rather than at a guard on the word
 * "desktop".
 */
describe('/devices/enroll — ownership follows sign-in, on every platform', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(enrollmentRoutes);
    await app.ready();
  });

  const body = (kind: 'desktop' | 'mobile') => ({
    challenge: 'x'.repeat(43),
    publicKey: 'a'.repeat(43),
    signature: 'b'.repeat(86),
    kind,
    // A real wire device id. `fingerprint-1` used to be enough, and stopped
    // being once `/devices/enroll` started applying the same shape rule
    // `/connect/request` always had — a 400 for a malformed body arrives
    // before this guard, which is the right order and not what this is about.
    fingerprint: 'desktop-11111111-1111-4111-8111-111111111111',
    name: 'Ada’s MacBook',
    platform: 'macos',
  });

  /** The reported bug, at the route. A Mac signing in used to be told its own
   * kind was the problem; now it is admitted and judged on its proof like
   * anything else. `deviceIdentity` is stubbed to refuse every challenge, so
   * "got past the guard" is observable as the LATER failure. */
  it('admits kind:"desktop" with a valid account token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/devices/enroll',
      headers: { authorization: 'Bearer account-token' },
      payload: body('desktop'),
    });
    expect(res.statusCode).not.toBe(403);
    expect(res.json().error).not.toBe('desktop_enrollment_requires_approval');
  });

  /** Ownership at sign-in must not become ownership WITHOUT sign-in. A machine
   * that cannot prove possession of its key is still refused, so the account
   * token alone never enrols a key the caller does not hold. */
  it('still refuses a desktop whose signature does not verify', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/devices/enroll',
      headers: { authorization: 'Bearer account-token' },
      payload: { ...body('desktop'), signature: 'z'.repeat(86) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('still requires a token at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/devices/enroll',
      payload: body('desktop'),
    });
    expect(res.statusCode).toBe(401);
  });

  /** The point of the change: the two kinds are no longer treated differently.
   * Both reach the proof and both fail there, identically. */
  it('treats desktop and mobile identically', async () => {
    const [desktop, mobile] = await Promise.all(
      (['desktop', 'mobile'] as const).map((kind) =>
        app.inject({
          method: 'POST',
          url: '/devices/enroll',
          headers: { authorization: 'Bearer account-token' },
          payload: body(kind),
        }),
      ),
    );
    expect(desktop!.statusCode).toBe(mobile!.statusCode);
    expect(desktop!.json()).toEqual(mobile!.json());
  });
});

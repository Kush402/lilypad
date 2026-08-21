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
 * A signed-in computer may not link itself
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md),
 * [ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
 *
 * `/devices/enroll` takes an account token and writes `devices.user_id`, which
 * is precisely the ownership relationship ADR-0010 says must cost a phone
 * approval. Nothing could reach that branch while the desktop had no way to
 * hold an account token — ADR-0012 gives it one, so the rule has to be enforced
 * on the server rather than by client convention.
 */
describe('/devices/enroll — desktops cannot self-link', () => {
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
    fingerprint: 'fingerprint-1',
    name: 'Ada’s MacBook',
    platform: 'macos',
  });

  it('refuses kind:"desktop" with a valid account token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/devices/enroll',
      headers: { authorization: 'Bearer account-token' },
      payload: body('desktop'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('desktop_enrollment_requires_approval');
  });

  /** The refusal must be about the KIND, not about the credential — otherwise
   * a future change that fixes the token could silently reopen the hole. */
  it('still refuses before it ever checks the signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/devices/enroll',
      headers: { authorization: 'Bearer account-token' },
      payload: { ...body('desktop'), signature: 'z'.repeat(86) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('still requires a token at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/devices/enroll',
      payload: body('desktop'),
    });
    expect(res.statusCode).toBe(401);
  });

  /** Phones enrol exactly as before: this guard must not have closed the path
   * the whole account model depends on. A mobile request gets past the guard
   * and fails later, on the challenge it cannot have — a different failure. */
  it('does not refuse kind:"mobile" at the guard', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/devices/enroll',
      headers: { authorization: 'Bearer account-token' },
      payload: body('mobile'),
    });
    expect(res.statusCode).not.toBe(403);
  });
});

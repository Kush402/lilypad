import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Mocked before the route modules are imported, so the routes get these.
// Everything downstream of the gate (Postgres, Redis, the hub) is deliberately
// never reached: a denied request must return before it touches any of them,
// and a test that needed infrastructure to prove that would be proving less.
vi.mock('../auth/ownership.js', () => ({
  deviceOwnershipByFingerprint: vi.fn(),
  deviceOwnershipById: vi.fn(),
  pairOwnership: vi.fn(),
  ownsDevice: vi.fn(),
  canManagePair: vi.fn(),
}));

const { deviceOwnershipByFingerprint, deviceOwnershipById, pairOwnership } =
  await import('../auth/ownership.js');
const { deviceRoutes } = await import('./devices.js');
const { pairingRoutes } = await import('./pairing.js');
const { signalingRoutes } = await import('./signaling.js');

/**
 * Route WIRING for M9 authorization
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
 *
 * `auth/authorize.test.ts` proves the rule is right. This proves every route
 * actually asks it — the failure mode that rule tests cannot catch is a route
 * that simply forgot its `preHandler`, which looks finished and authorizes
 * nothing.
 *
 * Each route is asserted three ways:
 *   1. a bad token is a 401 (the `optionalAuth` preHandler is registered),
 *   2. an anonymous request naming a LINKED device is a 404 (the gate ran and
 *      denied), and
 *   3. the ownership resolver was called with what the request named (the
 *      route looked up the right resource, not a hardcoded pass).
 */

const LINKED_LAPTOP = { deviceId: 'dev-laptop', userId: 'user-alice', state: 'linked' as const };
const LINKED_PHONE = { deviceId: 'dev-phone', userId: 'user-alice', state: 'linked' as const };
const PAIR_ID = '11111111-2222-4333-8444-555555555555';
const ALICES_PAIR = { pairId: PAIR_ID, desktop: LINKED_LAPTOP, mobile: LINKED_PHONE };

/** Enough of a hub bundle to register the routes. Nothing on it may be called:
 * every request in this file is denied at the gate, which is the point. */
const unreachable = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return undefined; // not a thenable
      return () => {
        throw new Error(`a denied request reached the hub (.${String(prop)}) — the gate leaked`);
      };
    },
  },
);

const stubBundle = {
  hub: {
    ...(unreachable as object),
    // Called once at registration, before any request.
    resurrectRoomsFromStore: async () => 0,
    metricsSnapshot: () => ({}),
    reapStale: () => {},
    shutdownAll: () => {},
    isRegistered: () => false,
  },
  sessions: { sweepOrphaned: async () => 0 },
  roomAuth: unreachable,
  trust: unreachable,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(pairingRoutes);
  await app.register(signalingRoutes, stubBundle as any);
  await app.register(deviceRoutes, { hub: stubBundle.hub as any });
  await app.ready();
  return app;
}

/** Every route reached by a request that names an account-owned resource. */
const routes = [
  {
    name: 'GET /devices/pairs',
    request: {
      method: 'GET' as const,
      url: '/devices/pairs?desktopDeviceId=desktop-laptop-fingerprint',
    },
    resolves: 'device' as const,
    named: ['desktop', 'desktop-laptop-fingerprint'],
  },
  {
    name: 'PATCH /devices/pairs/:pairId',
    request: {
      method: 'PATCH' as const,
      url: `/devices/pairs/${PAIR_ID}`,
      payload: { autoApprove: true },
    },
    resolves: 'pair' as const,
    named: [PAIR_ID],
  },
  {
    name: 'DELETE /devices/pairs/:pairId',
    request: { method: 'DELETE' as const, url: `/devices/pairs/${PAIR_ID}` },
    resolves: 'pair' as const,
    named: [PAIR_ID],
  },
  {
    name: 'POST /devices/unpair',
    request: {
      method: 'POST' as const,
      url: '/devices/unpair',
      payload: {
        desktopDeviceId: 'desktop-laptop-fingerprint',
        mobileDeviceId: 'mobile-phone-fingerprint',
      },
    },
    resolves: 'device' as const,
    named: ['mobile', 'mobile-phone-fingerprint'],
  },
  {
    name: 'POST /connect/request',
    request: {
      method: 'POST' as const,
      url: '/connect/request',
      payload: {
        desktopDeviceId: 'desktop-laptop-fingerprint',
        mobileDeviceId: 'mobile-phone-fingerprint',
        mobileDeviceName: 'a phone',
      },
    },
    resolves: 'device' as const,
    named: ['mobile', 'mobile-phone-fingerprint'],
  },
  {
    name: 'POST /pairing/create',
    request: {
      method: 'POST' as const,
      url: '/pairing/create',
      payload: {
        deviceId: 'desktop-laptop-fingerprint',
        deviceName: 'a laptop',
        platform: 'macos',
      },
    },
    resolves: 'device' as const,
    named: ['desktop', 'desktop-laptop-fingerprint'],
  },
  {
    name: 'POST /pairing/redeem',
    request: {
      method: 'POST' as const,
      url: '/pairing/redeem',
      payload: {
        token: 'a'.repeat(32),
        deviceId: 'mobile-phone-fingerprint',
        deviceName: 'a phone',
        platform: 'ios',
      },
    },
    resolves: 'device' as const,
    named: ['mobile', 'mobile-phone-fingerprint'],
  },
];

describe('M9 route authorization wiring', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.mocked(deviceOwnershipByFingerprint).mockReset();
    vi.mocked(pairOwnership).mockReset();
    app = await buildApp();
  });

  for (const route of routes) {
    describe(route.name, () => {
      it('refuses an anonymous caller that names an account-linked resource', async () => {
        vi.mocked(deviceOwnershipByFingerprint).mockResolvedValue(
          route.named[0] === 'desktop' ? LINKED_LAPTOP : LINKED_PHONE,
        );
        vi.mocked(pairOwnership).mockResolvedValue(ALICES_PAIR);

        const res = await app.inject(route.request);

        expect(res.statusCode).toBe(404);
        const resolver =
          route.resolves === 'pair'
            ? vi.mocked(pairOwnership)
            : vi.mocked(deviceOwnershipByFingerprint);
        expect(resolver).toHaveBeenCalledWith(...route.named);
      });

      it('rejects a present-but-invalid token rather than downgrading it', async () => {
        const res = await app.inject({
          ...route.request,
          headers: { authorization: 'Bearer not-a-real-token' },
        });
        expect(res.statusCode).toBe(401);
        // The gate is never even consulted: the preHandler answered first.
        expect(deviceOwnershipByFingerprint).not.toHaveBeenCalled();
        expect(pairOwnership).not.toHaveBeenCalled();
      });
    });
  }

  it('covers every mutating pairing/trust route the desktop and phone call', () => {
    // A route added later without a gate is the exact regression this file
    // exists to catch, and a list that silently shrinks catches nothing.
    expect(routes.map((r) => r.name).sort()).toEqual([
      'DELETE /devices/pairs/:pairId',
      'GET /devices/pairs',
      'PATCH /devices/pairs/:pairId',
      'POST /connect/request',
      'POST /devices/unpair',
      'POST /pairing/create',
      'POST /pairing/redeem',
    ]);
  });
});

/**
 * The account-device routes (P2) are gated differently on purpose, and the
 * difference is the point: `/devices/pairs` has an unowned lane because a
 * pre-accounts laptop has no owner to protect, but `/devices` IS an account's
 * device list — without an account there is nothing to list, so an anonymous
 * caller gets 401 rather than an empty array.
 */
describe('P2 account-device route authorization', () => {
  let app: FastifyInstance;

  const DEVICE_ID = '22222222-3333-4444-8555-666666666666';
  const accountRoutes = [
    { name: 'GET /devices', request: { method: 'GET' as const, url: '/devices' } },
    {
      name: 'PATCH /devices/:deviceId',
      request: {
        method: 'PATCH' as const,
        url: `/devices/${DEVICE_ID}`,
        payload: { name: 'Work phone' },
      },
    },
    {
      name: 'DELETE /devices/:deviceId',
      request: { method: 'DELETE' as const, url: `/devices/${DEVICE_ID}` },
    },
  ];

  beforeEach(async () => {
    vi.mocked(deviceOwnershipById).mockReset();
    app = await buildApp();
  });

  for (const route of accountRoutes) {
    it(`${route.name} refuses an anonymous caller outright`, async () => {
      const res = await app.inject(route.request);
      expect(res.statusCode).toBe(401);
    });

    it(`${route.name} refuses a bad token`, async () => {
      const res = await app.inject({
        ...route.request,
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(res.statusCode).toBe(401);
    });
  }

  // The trap this asserts against: `/devices/pairs/:pairId` and
  // `/devices/:deviceId` are both two-segment-plus-param routes on the same
  // prefix. If the parametric route ever won, a pair id would be routed into
  // device revocation — revoking a DEVICE when the user asked to revoke a
  // PAIR, which is a far stronger act than they consented to.
  it('routes /devices/pairs/:pairId to pair management, never to device revocation', async () => {
    vi.mocked(pairOwnership).mockResolvedValue(ALICES_PAIR);
    vi.mocked(deviceOwnershipById).mockResolvedValue(LINKED_PHONE);

    const res = await app.inject({ method: 'DELETE', url: `/devices/pairs/${PAIR_ID}` });

    // 404 is the pair route denying an anonymous caller; the device route
    // would have answered 401, and a 401 here would mean it matched.
    expect(res.statusCode).toBe(404);
    expect(pairOwnership).toHaveBeenCalledWith(PAIR_ID);
    expect(deviceOwnershipById).not.toHaveBeenCalled();
  });

  // Device revocation withdraws OWNERSHIP; the `trusted_devices` rows survive
  // as audit trail. So `authorizeConnect` still passes a pair whose laptop was
  // removed from the account, and the ring used to fall through to the presence
  // check and answer 503 `desktop_offline` — measured against production. No
  // access was granted either way, because a revoked device cannot hold a
  // device token and so can never occupy a presence room. What was wrong is
  // what it told the owner: that their Mac was offline, when it had been
  // removed.
  it('refuses to ring a desktop that was removed from the account', async () => {
    vi.mocked(deviceOwnershipByFingerprint).mockImplementation(async (kind) =>
      kind === 'mobile'
        ? { deviceId: 'dev-phone', userId: null, state: 'unlinked' }
        : { deviceId: 'dev-laptop', userId: 'user-alice', state: 'revoked' },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/connect/request',
      payload: {
        desktopDeviceId: 'desktop-laptop-fingerprint',
        mobileDeviceId: 'mobile-phone-fingerprint',
        mobileDeviceName: 'a phone',
      },
    });

    // 404, not a distinct code: a caller that could tell "removed" from "no
    // such pair" could enumerate which laptops exist.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_trusted' });
  });
});

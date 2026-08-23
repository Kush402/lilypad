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

/**
 * The unowned lane, closed.
 *
 * `authorize.ts` used to ALLOW any request naming a device that belonged to no
 * account, described in the source as a migration ramp that would close "once
 * P1 makes enrolment mandatory". P1 chose the opposite — linking stayed
 * optional — so the ramp had quietly become permanent, and knowing a
 * fingerprint was sufficient to act as any unlinked device on every route
 * below.
 *
 * The product model is now account -> devices, so a device on no account may
 * do nothing. These run the same route table as above against UNOWNED
 * resources, and against a real token as well as an anonymous caller, because
 * the old behaviour let both through.
 */
describe('a device that belongs to no account', () => {
  const UNOWNED_LAPTOP = { deviceId: 'dev-laptop', userId: null, state: 'unlinked' as const };
  const UNOWNED_PHONE = { deviceId: 'dev-phone', userId: null, state: 'unlinked' as const };
  const ORPHAN_PAIR = { pairId: PAIR_ID, desktop: UNOWNED_LAPTOP, mobile: UNOWNED_PHONE };

  let app: FastifyInstance;

  beforeEach(async () => {
    vi.mocked(deviceOwnershipByFingerprint).mockReset();
    vi.mocked(pairOwnership).mockReset();
    app = await buildApp();
  });

  for (const route of routes) {
    it(`is refused ${route.name}`, async () => {
      vi.mocked(deviceOwnershipByFingerprint).mockResolvedValue(
        route.named[0] === 'desktop' ? UNOWNED_LAPTOP : UNOWNED_PHONE,
      );
      vi.mocked(pairOwnership).mockResolvedValue(ORPHAN_PAIR);

      const res = await app.inject(route.request);

      expect(res.statusCode).toBe(404);
    });
  }

  /**
   * A device the backend has never seen is not a lesser-privileged device
   * either. This was the second half of the old lane: `device === null`
   * returned allow, on the reasoning that the route's own not-found handling
   * would answer instead.
   */
  for (const route of routes) {
    it(`is refused ${route.name} even when the row does not exist at all`, async () => {
      vi.mocked(deviceOwnershipByFingerprint).mockResolvedValue(null);
      vi.mocked(pairOwnership).mockResolvedValue(null);

      const res = await app.inject(route.request);

      expect(res.statusCode).toBe(404);
    });
  }
});

/**
 * `GET /devices/pairs/mine` — the phone's own list, added for L-10.
 *
 * `requireDevice` rather than the `optionalAuth` gate the routes above use,
 * because the resource is defined BY the caller: "my pairs" is meaningless
 * without knowing which device is asking, and a device id in a query string
 * would let anyone enumerate any phone's laptops.
 */
describe('GET /devices/pairs/mine', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.mocked(deviceOwnershipByFingerprint).mockReset();
    vi.mocked(pairOwnership).mockReset();
    app = await buildApp();
  });

  it('refuses an anonymous caller outright, rather than answering an empty list', async () => {
    // An empty list would be a lie with a specific shape: "you have paired
    // nothing", to someone who has not said who they are.
    const res = await app.inject({ method: 'GET', url: '/devices/pairs/mine' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a present-but-invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/devices/pairs/mine',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * `mine` is a literal segment sitting where `:pairId` also matches. If the
   * parameterised route won, every phone asking for its list would instead hit
   * the pair handler with a pairId of "mine".
   */
  it('does not swallow the pairId route it shares a prefix with', async () => {
    vi.mocked(pairOwnership).mockResolvedValue(ALICES_PAIR);

    const res = await app.inject({ method: 'DELETE', url: `/devices/pairs/${PAIR_ID}` });

    // 404 from the ownership gate, which means the pairId handler ran at all.
    expect(res.statusCode).toBe(404);
    expect(pairOwnership).toHaveBeenCalledWith(PAIR_ID);
  });
});

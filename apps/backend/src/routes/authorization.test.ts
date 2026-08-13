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

const { deviceOwnershipByFingerprint, pairOwnership } = await import('../auth/ownership.js');
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
    request: { method: 'GET' as const, url: '/devices/pairs?desktopDeviceId=laptop-fingerprint' },
    resolves: 'device' as const,
    named: ['desktop', 'laptop-fingerprint'],
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
      payload: { desktopDeviceId: 'laptop-fingerprint', mobileDeviceId: 'phone-fingerprint' },
    },
    resolves: 'device' as const,
    named: ['mobile', 'phone-fingerprint'],
  },
  {
    name: 'POST /connect/request',
    request: {
      method: 'POST' as const,
      url: '/connect/request',
      payload: {
        desktopDeviceId: 'laptop-fingerprint',
        mobileDeviceId: 'phone-fingerprint',
        mobileDeviceName: 'a phone',
      },
    },
    resolves: 'device' as const,
    named: ['mobile', 'phone-fingerprint'],
  },
  {
    name: 'POST /pairing/create',
    request: {
      method: 'POST' as const,
      url: '/pairing/create',
      payload: { deviceId: 'laptop-fingerprint', deviceName: 'a laptop', platform: 'macos' },
    },
    resolves: 'device' as const,
    named: ['desktop', 'laptop-fingerprint'],
  },
  {
    name: 'POST /pairing/redeem',
    request: {
      method: 'POST' as const,
      url: '/pairing/redeem',
      payload: {
        token: 'a'.repeat(32),
        deviceId: 'phone-fingerprint',
        deviceName: 'a phone',
        platform: 'ios',
      },
    },
    resolves: 'device' as const,
    named: ['mobile', 'phone-fingerprint'],
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

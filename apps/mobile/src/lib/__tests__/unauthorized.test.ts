import { accessToken, approveDesktopEnrollment, DeviceAuthError, resetAuthState } from '../auth';
import { listAccountDevices, revokeAccountDevice, AccountDeviceError } from '../accountDevices';
import { resetDeviceKeyCache } from '../identity';
import { saveSession, resetSessionCacheForTests } from '../session';

/**
 * What a 401 has to mean to a phone.
 *
 * Reconstructed from production on 2026-08-24, from the backend's own request
 * log. A customer opened "Your devices" to tidy up before re-pairing and
 * tapped Remove down the list. The first entry was the phone in their hand —
 * an act the screen warns about ("It will be signed out immediately") and one
 * the product supports:
 *
 *   21:17:25.070  200  /devices/token             the phone takes a token
 *   21:17:25.184  200  /devices                   the list loads
 *   21:17:27.595  200  /devices/2ab99593…         DELETE — succeeds
 *   21:17:27.671  401  /devices                   and everything dies
 *   21:17:29.620  401  /devices/2ab99593…
 *   21:17:46.879  401  /devices/enrollment-code/approve
 *
 * Nothing in the app recognised any of it. `invalidateAccessToken` carried the
 * comment "Called when the backend answers 401" and had no such caller, so the
 * dead token stayed cached for its full ten-minute TTL, and the linking card
 * read `could not add that computer (HTTP 401)` — a status code, and no way
 * back. `401` appeared exactly once in the whole non-test mobile source: in
 * that comment.
 *
 * The remedy already existed. `DeviceAuthError('device_revoked')` says "This
 * phone was removed from the account. Sign in to add it again.", and both
 * `ScannerScreen` and `AccountDevicesScreen` route it to sign-in. These tests
 * pin the wiring that was missing between them.
 */

jest.mock('react-native-keychain', () => {
  const store = new Map<string, { username: string; password: string }>();
  const key = (options?: { service?: string }) => options?.service ?? 'default';
  return {
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
    getGenericPassword: jest.fn((options?: { service?: string }) =>
      Promise.resolve(store.get(key(options)) ?? false),
    ),
    setGenericPassword: jest.fn(
      (username: string, password: string, options?: { service?: string }) => {
        store.set(key(options), { username, password });
        return Promise.resolve(true);
      },
    ),
    resetGenericPassword: jest.fn((options?: { service?: string }) => {
      store.delete(key(options));
      return Promise.resolve(true);
    }),
  };
});

const API = 'http://localhost:8080';
const realFetch = globalThis.fetch;

/**
 * A backend that hands out device tokens normally, and answers everything
 * else from `routes` — so a test can serve 200 to one call and 401 to the
 * next, which is exactly the shape of the incident.
 */
function mockBackend(routes: Array<{ match: string; status: number; body?: string }>) {
  const counts = { token: 0 };
  const fetchMock = jest.fn((url: string, init?: { method?: string }) => {
    if (url.endsWith('/devices/challenge')) {
      return Promise.resolve({
        status: 201,
        text: () => Promise.resolve(JSON.stringify({ challenge: 'a-server-issued-nonce' })),
      });
    }
    if (url.endsWith('/devices/token')) {
      counts.token += 1;
      return Promise.resolve({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              accessToken: `token-${counts.token}`,
              expiresInSeconds: 600,
              deviceId: 'device-uuid',
              userId: 'user-uuid',
            }),
          ),
      });
    }
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no route for ${init?.method ?? 'GET'} ${url}`);
    const body = route.body ?? '{}';
    return Promise.resolve({
      status: route.status,
      ok: route.status >= 200 && route.status < 300,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body)),
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return counts;
}

beforeEach(async () => {
  resetAuthState();
  resetDeviceKeyCache();
  resetSessionCacheForTests();
  jest.clearAllMocks();
  await saveSession({ userId: 'user-uuid', apiBaseUrl: API });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('a 401 tells the phone about itself, not about the request', () => {
  // The literal line from the screenshot the customer sent.
  it('does not put a bare status code on the linking card', async () => {
    mockBackend([
      {
        match: '/devices/enrollment-code/approve',
        status: 401,
        body: '{"error":"device_revoked"}',
      },
    ]);
    await expect(approveDesktopEnrollment(API, '123456')).rejects.toThrow(DeviceAuthError);
    await expect(approveDesktopEnrollment(API, '123456')).rejects.toThrow(
      'This phone was removed from the account. Sign in to add it again.',
    );
  });

  // `requireAuth` answers a plain `unauthorized` for a token that no longer
  // verifies. Same remedy, different sentence — claiming the device was
  // removed when it was not would be a guess presented as a fact.
  it('distinguishes an expired token from a revoked device', async () => {
    mockBackend([
      { match: '/devices/enrollment-code/approve', status: 401, body: '{"error":"unauthorized"}' },
    ]);
    await expect(approveDesktopEnrollment(API, '123456')).rejects.toThrow(
      'This phone is not signed in yet.',
    );
  });

  /**
   * The whole incident in one test: revoke succeeds, and the refresh that
   * follows it must raise the error `AccountDevicesScreen` already routes to
   * sign-in — not `Could not load your devices (HTTP 401)`, which is where it
   * used to land and which offers nothing to do.
   */
  it('sends the refresh after a self-revoke to sign-in', async () => {
    mockBackend([
      { match: '/devices/2ab99593', status: 200 },
      { match: '/devices', status: 401, body: '{"error":"device_revoked"}' },
    ]);
    await expect(revokeAccountDevice(API, '2ab99593')).resolves.toBeUndefined();
    const failure = await listAccountDevices(API).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DeviceAuthError);
    expect(failure).not.toBeInstanceOf(AccountDeviceError);
  });

  /**
   * The cache is why this outlived the request that hit it. A device token is
   * held for ten minutes, so without dropping it here every later call reuses
   * a credential the server has already refused.
   */
  it('drops the cached token so the next call re-authenticates', async () => {
    const counts = mockBackend([
      {
        match: '/devices/enrollment-code/approve',
        status: 401,
        body: '{"error":"device_revoked"}',
      },
    ]);
    await accessToken(API);
    expect(counts.token).toBe(1);
    // Cached: no second exchange yet.
    await accessToken(API);
    expect(counts.token).toBe(1);

    await expect(approveDesktopEnrollment(API, '123456')).rejects.toThrow(DeviceAuthError);

    await accessToken(API);
    expect(counts.token).toBe(2);
  });
});

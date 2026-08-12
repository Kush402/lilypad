import { accessToken, signInDevice, DeviceAuthError, resetAuthState } from '../auth';
import { resetDeviceKeyCache } from '../identity';

jest.mock('react-native-keychain', () => {
  let stored: { username: string; password: string } | null = null;
  return {
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
    getGenericPassword: jest.fn(() => Promise.resolve(stored ?? false)),
    setGenericPassword: jest.fn((username: string, password: string) => {
      stored = { username, password };
      return Promise.resolve(true);
    }),
  };
});

const API = 'http://localhost:8080';

/** Serves a challenge then a device session, counting how many of each the
 * client actually asked for. */
function mockBackend(options: { tokenStatus?: number; tokenBody?: string; ttl?: number } = {}) {
  const counts = { challenge: 0, token: 0 };
  const fetchMock = jest.fn((url: string) => {
    if (url.endsWith('/devices/challenge')) {
      counts.challenge += 1;
      return Promise.resolve({
        status: 201,
        text: () => Promise.resolve(JSON.stringify({ challenge: `nonce-${counts.challenge}` })),
      });
    }
    counts.token += 1;
    return Promise.resolve({
      status: options.tokenStatus ?? 200,
      text: () =>
        Promise.resolve(
          options.tokenBody ??
            JSON.stringify({
              accessToken: `token-${counts.token}`,
              expiresInSeconds: options.ttl ?? 600,
              deviceId: 'device-uuid',
              userId: 'user-uuid',
            }),
        ),
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return counts;
}

beforeEach(() => {
  resetAuthState();
  resetDeviceKeyCache();
  jest.clearAllMocks();
});

describe('device access tokens', () => {
  it('signs in by proving key possession over a server-issued challenge', async () => {
    const counts = mockBackend();
    const session = await signInDevice(API);
    expect(session.accessToken).toBe('token-1');
    expect(counts.challenge).toBe(1);
  });

  it('reuses a cached token instead of re-authenticating', async () => {
    const counts = mockBackend();
    await accessToken(API);
    await accessToken(API);
    expect(counts.token).toBe(1);
  });

  // Without sharing, a screen that fires several requests at once burns several
  // challenges and races to overwrite the cache with whichever lands last.
  it('shares one exchange between concurrent callers', async () => {
    const counts = mockBackend();
    const tokens = await Promise.all([accessToken(API), accessToken(API), accessToken(API)]);
    expect(new Set(tokens).size).toBe(1);
    expect(counts.token).toBe(1);
  });

  // A TTL below the renewal margin must still cache something, or every single
  // call performs a full challenge round-trip.
  it('caches even when the server TTL is shorter than the renewal margin', async () => {
    const counts = mockBackend({ ttl: 10 });
    await accessToken(API);
    await accessToken(API);
    expect(counts.token).toBe(1);
  });

  it('reports a revoked device distinctly, so the UI does not retry forever', async () => {
    mockBackend({ tokenStatus: 403, tokenBody: '{"error":"device_revoked"}' });
    await expect(signInDevice(API)).rejects.toBeInstanceOf(DeviceAuthError);
    await expect(signInDevice(API)).rejects.toMatchObject({ code: 'device_revoked' });
  });

  it('reports an un-enrolled device distinctly', async () => {
    mockBackend({ tokenStatus: 403, tokenBody: '{"error":"device_not_enrolled"}' });
    await expect(signInDevice(API)).rejects.toMatchObject({ code: 'device_not_enrolled' });
  });

  it('surfaces an unexpected status rather than pretending to be signed in', async () => {
    mockBackend({ tokenStatus: 500, tokenBody: 'boom' });
    await expect(signInDevice(API)).rejects.toThrow(/HTTP 500/);
  });

  it('lets a later call retry after a failed exchange', async () => {
    mockBackend({ tokenStatus: 500, tokenBody: 'boom' });
    await expect(accessToken(API)).rejects.toThrow();
    const counts = mockBackend();
    await expect(accessToken(API)).resolves.toBe('token-1');
    expect(counts.token).toBe(1);
  });
});

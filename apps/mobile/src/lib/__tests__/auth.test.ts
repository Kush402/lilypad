import {
  accessToken,
  signInDevice,
  enrollDevice,
  DeviceAuthError,
  invalidateAccessToken,
  resetAuthState,
} from '../auth';
import { resetDeviceKeyCache } from '../identity';
import { saveSession, resetSessionCacheForTests } from '../session';

/**
 * Keyed by `service`, because the real module is — and because this file now
 * stores a session record alongside the device key. A single-slot mock would
 * have the session overwrite the key, and the next signature would fail
 * parsing JSON as base64url.
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
    __reset: () => store.clear(),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** Hold token responses across a local sign-out or identity reset. */
function pendingBackend() {
  const requests: Array<{
    finish: (status: number, body: object) => void;
  }> = [];
  const waiting = [deferred<void>(), deferred<void>(), deferred<void>()];
  globalThis.fetch = jest.fn((url: string) => {
    if (url.endsWith('/devices/challenge')) {
      return Promise.resolve({
        status: 201,
        text: () => Promise.resolve(JSON.stringify({ challenge: 'nonce' })),
      });
    }
    const response = deferred<{ status: number; text: () => Promise<string> }>();
    requests.push({
      finish: (status, body) => {
        response.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
      },
    });
    waiting[requests.length - 1]?.resolve();
    return response.promise;
  }) as unknown as typeof fetch;
  return { requests, waiting };
}

function tokenBody(accessToken: string) {
  return { accessToken, expiresInSeconds: 600, deviceId: 'device-uuid', userId: 'user-uuid' };
}

beforeEach(async () => {
  resetAuthState();
  resetDeviceKeyCache();
  resetSessionCacheForTests();
  jest.clearAllMocks();
  // A device token is only ever taken against the backend this phone is
  // signed in to (`assertHomeBackend`), so every test here needs to be signed
  // in to `API` — which is the state any code path that reaches `accessToken`
  // is in, since the app has no route to it while signed out.
  await saveSession({ userId: 'user-uuid', apiBaseUrl: API });
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
    // It must still FAIL — but in words. This assertion used to be
    // `toThrow(/HTTP 500/)`, and that string went straight onto the sign-in
    // screen, which renders `err.message` verbatim.
    const err = await signInDevice(API).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/HTTP|500|boom/);
    expect(err!.message).toMatch(/try again/i);
  });

  it('says how long to wait when the server is rate-limiting', async () => {
    // 60/minute per address on the challenge and token routes, so a shared
    // network reaches this without anyone doing anything unusual.
    mockBackend({ tokenStatus: 429, tokenBody: '{"statusCode":429}' });
    await expect(signInDevice(API)).rejects.toThrow(/wait a minute/i);
  });

  it('lets a later call retry after a failed exchange', async () => {
    mockBackend({ tokenStatus: 500, tokenBody: 'boom' });
    await expect(accessToken(API)).rejects.toThrow();
    const counts = mockBackend();
    await expect(accessToken(API)).resolves.toBe('token-1');
    expect(counts.token).toBe(1);
  });

  it.each([resetAuthState, invalidateAccessToken])(
    'does not return or cache a response that finishes after %p',
    async (invalidate) => {
      const { requests, waiting } = pendingBackend();
      const old = accessToken(API);
      const rejected = expect(old).rejects.toThrow(/sign-in changed/i);
      await waiting[0].promise;
      invalidate();
      requests[0].finish(200, tokenBody('old-token'));
      await rejected;
      const counts = mockBackend();
      await expect(accessToken(API)).resolves.toBe('token-1');
      expect(counts.token).toBe(1);
    },
  );

  it.each([200, 403])(
    'an old %i response cannot replace the new exchange or its cached verdict',
    async (status) => {
      const { requests, waiting } = pendingBackend();
      const old = accessToken(API);
      const rejected = expect(old).rejects.toThrow(/sign-in changed/i);
      await waiting[0].promise;
      resetAuthState();
      const current = accessToken(API);
      await waiting[1].promise;
      requests[0].finish(
        status,
        status === 200 ? tokenBody('old-token') : { error: 'device_revoked' },
      );
      await rejected;
      const concurrent = accessToken(API);
      requests[1].finish(200, tokenBody('new-token'));
      await expect(Promise.all([current, concurrent])).resolves.toEqual(['new-token', 'new-token']);
      await expect(accessToken(API)).resolves.toBe('new-token');
      expect(requests).toHaveLength(2);
    },
  );

  it('rejects an enrollment response from before the identity was reset', async () => {
    const { requests, waiting } = pendingBackend();
    const old = enrollDevice(API, 'account-token');
    const rejected = expect(old).rejects.toThrow(/sign-in changed/i);
    await waiting[0].promise;
    resetAuthState();
    requests[0].finish(200, tokenBody('old-enrollment-token'));
    await rejected;
    const counts = mockBackend();
    await expect(accessToken(API)).resolves.toBe('token-1');
    expect(counts.token).toBe(1);
  });
});

/**
 * M9: pairing now asks for a token on the way past (`api.ts`), and most phones
 * have no account until P1 lands sign-in. Re-running the exchange on every
 * scan and every reconnect, to be told the same thing each time, would put two
 * pointless round trips in front of the product's core flow.
 */
describe('a phone with no account behind it', () => {
  it('stops re-asking once the backend has said so', async () => {
    const counts = mockBackend({ tokenStatus: 403, tokenBody: '{"error":"device_not_enrolled"}' });
    await expect(accessToken(API)).rejects.toMatchObject({ code: 'device_not_enrolled' });
    await expect(accessToken(API)).rejects.toMatchObject({ code: 'device_not_enrolled' });
    expect(counts.token).toBe(1);
    expect(counts.challenge).toBe(1);
  });

  // A verdict is memoized; a network blip must not be, or one bad moment
  // would leave the phone unable to prove itself for the rest of the run.
  it('keeps retrying after a transient failure', async () => {
    mockBackend({ tokenStatus: 500, tokenBody: 'boom' });
    await expect(accessToken(API)).rejects.toThrow(/try again/i);
    const counts = mockBackend();
    await expect(accessToken(API)).resolves.toBe('token-1');
    expect(counts.token).toBe(1);
  });

  // Enrolling is exactly the event that makes the memo wrong.
  it('starts asking again once it enrols', async () => {
    mockBackend({ tokenStatus: 403, tokenBody: '{"error":"device_not_enrolled"}' });
    await expect(accessToken(API)).rejects.toThrow();
    const counts = mockBackend();
    await expect(enrollDevice(API, 'an-account-token')).resolves.toMatchObject({
      accessToken: 'token-1',
    });
    await expect(accessToken(API)).resolves.toBe('token-1'); // cached, no new exchange
    expect(counts.token).toBe(1);
  });
});

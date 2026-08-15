import { loadSession, saveSession, clearSession, resetSessionCacheForTests } from '../session';

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
    __store: store,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const keychain = require('react-native-keychain') as {
  __store: Map<string, { username: string; password: string }>;
  getGenericPassword: jest.Mock;
  setGenericPassword: jest.Mock;
};

beforeEach(() => {
  keychain.__store.clear();
  resetSessionCacheForTests();
  jest.clearAllMocks();
});

describe('the session record', () => {
  it('is absent before anyone signs in', async () => {
    expect(await loadSession()).toBeNull();
  });

  it('survives a restart', async () => {
    await saveSession({ userId: 'user-1', apiBaseUrl: 'https://api.example.com', email: 'a@b.c' });
    resetSessionCacheForTests();

    const loaded = await loadSession();
    expect(loaded?.userId).toBe('user-1');
    expect(loaded?.apiBaseUrl).toBe('https://api.example.com');
    expect(loaded?.email).toBe('a@b.c');
  });

  it('is gone after signing out', async () => {
    await saveSession({ userId: 'user-1', apiBaseUrl: 'https://api.example.com' });
    await clearSession();
    resetSessionCacheForTests();
    expect(await loadSession()).toBeNull();
  });

  /**
   * The record must never become a credential. Nothing here authenticates
   * anything — the phone's key does — and a token written beside it would be a
   * copyable credential for a job the key already does (`signIn.ts`).
   */
  it('stores no bearer token', async () => {
    await saveSession({ userId: 'user-1', apiBaseUrl: 'https://api.example.com', email: 'a@b.c' });
    const written = keychain.setGenericPassword.mock.calls.map((call) => String(call[1])).join('');
    expect(written).not.toMatch(/token/i);
  });

  /**
   * Its own Keychain service. `identity.ts` (the device key) and `pairs.ts`
   * (the paired laptops) each have their own too — sharing one would mean
   * writing any of the three destroyed the others.
   */
  it('uses its own keychain namespace', async () => {
    await saveSession({ userId: 'user-1', apiBaseUrl: 'https://api.example.com' });
    expect([...keychain.__store.keys()]).toEqual(['com.takedia.lilypad.session']);
  });

  /** A locked or unavailable Keychain must read as signed out, not crash the
   * launch gate — the app's very first render depends on this call. */
  it('reads as signed out when the keychain throws', async () => {
    keychain.getGenericPassword.mockRejectedValueOnce(new Error('keychain locked'));
    expect(await loadSession()).toBeNull();
  });
});

import { GoogleSignin } from '@react-native-google-signin/google-signin';
import appleAuthModule from '@invertase/react-native-apple-authentication';
import * as keychainModule from 'react-native-keychain';
import {
  signInWithGoogle,
  signInWithApple,
  signInWithPassword,
  signUpWithPassword,
  requestMagicLink,
  requestPasswordReset,
  confirmPasswordReset,
  verifyMagicLink,
  SignInError,
} from '../signIn';
import { loadSession, resetSessionCacheForTests } from '../session';
import { resetDeviceKeyCache } from '../identity';
import { resetAuthState } from '../auth';

/**
 * Keyed by `service`, because the real module is.
 *
 * A single-slot mock was accurate enough while only `identity.ts` used the
 * Keychain. It stopped being accurate the moment sign-in also wrote a session
 * record (`session.ts`) and pairs (`pairs.ts`): the session overwrote the
 * device key, and the next signature attempt failed parsing JSON as base64url —
 * a failure that could only ever happen in the mock.
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

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(() => Promise.resolve(true)),
    signIn: jest.fn(),
  },
}));

jest.mock('@invertase/react-native-apple-authentication', () => ({
  __esModule: true,
  default: {
    isSupported: true,
    performRequest: jest.fn(),
    Operation: { LOGIN: 1 },
    Scope: { EMAIL: 0, FULL_NAME: 1 },
    Error: { CANCELED: '1001' },
  },
}));

jest.mock('../../config/oauth', () => ({
  GOOGLE_WEB_CLIENT_ID: 'web-client-id.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id.apps.googleusercontent.com',
  isGoogleConfigured: () => true,
  APPLE_BUNDLE_ID: 'com.takedia.lilypad',
}));

// `jest.mock` is hoisted above these imports, so each binding is the mock.
// Importing rather than `require`ing keeps the module graph ESM-consistent with
// the code under test.
const google = GoogleSignin as unknown as {
  configure: jest.Mock;
  hasPlayServices: jest.Mock;
  signIn: jest.Mock;
};
const appleAuth = appleAuthModule as unknown as {
  isSupported: boolean;
  performRequest: jest.Mock;
  Error: { CANCELED: string };
};
const keychain = keychainModule as unknown as {
  setGenericPassword: jest.Mock;
  __reset: () => void;
};

const API = 'http://localhost:8080';

/** Serves the whole sign-in chain: /auth/oauth (or magic-link) then the
 * device challenge + enroll that every path ends with. */
function mockBackend(options: { oauthStatus?: number; oauthBody?: string } = {}) {
  const seen: string[] = [];
  globalThis.fetch = jest.fn((url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(url.replace(API, ''));
    if (url.includes('/auth/')) {
      return Promise.resolve({
        status:
          options.oauthStatus ??
          (url.includes('/reset/request') ? 202 : url.includes('/auth/signup') ? 201 : 200),
        text: () =>
          Promise.resolve(
            options.oauthBody ??
              JSON.stringify({
                accessToken: 'account-token',
                expiresInSeconds: 600,
                refreshToken: 'account-refresh',
                userId: 'user-uuid',
              }),
          ),
      });
    }
    if (url.endsWith('/devices/challenge')) {
      return Promise.resolve({
        status: 201,
        text: () => Promise.resolve(JSON.stringify({ challenge: 'a-nonce' })),
      });
    }
    // /devices/enroll — record the bearer so the test can assert the ACCOUNT
    // token was what authorised it.
    seen.push(`auth:${init?.headers?.authorization ?? 'none'}`);
    return Promise.resolve({
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            accessToken: 'device-token',
            expiresInSeconds: 600,
            deviceId: 'device-uuid',
            userId: 'user-uuid',
          }),
        ),
    });
  }) as unknown as typeof fetch;
  return seen;
}

beforeEach(() => {
  resetAuthState();
  resetDeviceKeyCache();
  resetSessionCacheForTests();
  // The store outlives a `clearAllMocks`, and this file now writes THREE
  // namespaces (device key, session, pairs). Without this, one test's session
  // record is still readable in the next one.
  keychain.__reset();
  jest.clearAllMocks();
  appleAuth.isSupported = true;
});

describe('Google sign-in', () => {
  it('exchanges the SDK ID token and enrolls this phone', async () => {
    const seen = mockBackend();
    google.signIn.mockResolvedValue({
      type: 'success',
      data: { idToken: 'google-id-token' },
    });

    const session = await signInWithGoogle(API);

    expect(session.deviceId).toBe('device-uuid');
    expect(seen).toEqual([
      '/auth/oauth',
      '/devices/challenge',
      '/devices/enroll',
      'auth:Bearer account-token',
    ]);
  });

  // The audience the backend checks comes from this value, so a wrong one
  // fails every sign-in with an opaque invalid_token.
  it('configures the SDK with the web client id', async () => {
    mockBackend();
    google.signIn.mockResolvedValue({ type: 'success', data: { idToken: 't' } });
    await signInWithGoogle(API);
    expect(google.configure).toHaveBeenCalledWith(
      expect.objectContaining({ webClientId: 'web-client-id.apps.googleusercontent.com' }),
    );
  });

  it('reports cancellation distinctly from failure', async () => {
    mockBackend();
    google.signIn.mockResolvedValue({ type: 'cancelled' });
    await expect(signInWithGoogle(API)).rejects.toMatchObject({ code: 'cancelled' });
  });

  // Android returns a "successful" sign-in with no ID token when webClientId is
  // missing or wrong. Without this branch that surfaces as a generic failure
  // and the real cause is invisible.
  it('names the likely cause when no ID token comes back', async () => {
    mockBackend();
    google.signIn.mockResolvedValue({ type: 'success', data: { idToken: null } });
    await expect(signInWithGoogle(API)).rejects.toMatchObject({ code: 'not_configured' });
    await expect(signInWithGoogle(API)).rejects.toThrow(/web client id/);
  });

  it('surfaces an unconfigured provider as such, not as a rejected sign-in', async () => {
    mockBackend({ oauthStatus: 503, oauthBody: '{"error":"provider_not_configured"}' });
    google.signIn.mockResolvedValue({ type: 'success', data: { idToken: 't' } });
    await expect(signInWithGoogle(API)).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('explains an unverified provider email', async () => {
    mockBackend({ oauthStatus: 403, oauthBody: '{"error":"email_unverified"}' });
    google.signIn.mockResolvedValue({ type: 'success', data: { idToken: 't' } });
    await expect(signInWithGoogle(API)).rejects.toThrow(/unverified email/);
  });
});

describe('Apple sign-in', () => {
  it('exchanges the identity token and enrolls this phone', async () => {
    const seen = mockBackend();
    appleAuth.performRequest.mockResolvedValue({ identityToken: 'apple-identity-token' });

    const session = await signInWithApple(API);

    expect(session.deviceId).toBe('device-uuid');
    expect(seen).toContain('/auth/oauth');
    expect(seen).toContain('/devices/enroll');
  });

  it('reports cancellation distinctly', async () => {
    mockBackend();
    appleAuth.performRequest.mockRejectedValue({ code: '1001' });
    await expect(signInWithApple(API)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses on a platform without Sign in with Apple', async () => {
    mockBackend();
    appleAuth.isSupported = false;
    await expect(signInWithApple(API)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('fails clearly when Apple returns no identity token', async () => {
    mockBackend();
    appleAuth.performRequest.mockResolvedValue({ identityToken: null });
    await expect(signInWithApple(API)).rejects.toThrow(/identity token/);
  });
});

describe('magic link', () => {
  it('accepts a request without revealing whether the account exists', async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({ status: 202, text: () => Promise.resolve('{"ok":true}') }),
    ) as unknown as typeof fetch;
    await expect(requestMagicLink(API, 'ada@example.com')).resolves.toBeUndefined();
  });

  it('reports an unavailable sender honestly', async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({ status: 503, text: () => Promise.resolve('{}') }),
    ) as unknown as typeof fetch;
    await expect(requestMagicLink(API, 'ada@example.com')).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('redeems a token and enrolls this phone', async () => {
    const seen = mockBackend();
    const session = await verifyMagicLink(API, 'a-magic-token');
    expect(session.deviceId).toBe('device-uuid');
    expect(seen).toContain('/devices/enroll');
  });

  it('reports an expired or reused link', async () => {
    mockBackend({ oauthStatus: 401, oauthBody: '{"error":"invalid_token"}' });
    await expect(verifyMagicLink(API, 'stale')).rejects.toThrow(/expired or was already used/);
  });
});

describe('what is persisted', () => {
  // The whole point of ADR-0002's no-refresh-token decision: after enrollment
  // the only durable credential on the phone is the private key. If an account
  // token were written to the keychain, this would catch it.
  it('never writes a bearer token to the keychain', async () => {
    mockBackend();
    google.signIn.mockResolvedValue({ type: 'success', data: { idToken: 't' } });
    await signInWithGoogle(API);

    const written = keychain.setGenericPassword.mock.calls.map((call) => String(call[1]));
    for (const value of written) {
      expect(value).not.toContain('account-token');
      expect(value).not.toContain('account-refresh');
      expect(value).not.toContain('device-token');
    }
  });
});

describe('SignInError', () => {
  it('carries a machine-readable code alongside a human message', () => {
    const error = new SignInError('cancelled', 'Sign-in cancelled.');
    expect(error.code).toBe('cancelled');
    expect(error.name).toBe('SignInError');
  });
});

// ── email + password (ADR-0012) ─────────────────────────────────────────────
describe('password sign-in', () => {
  it('creates an account, enrolls this phone, and records the session', async () => {
    const seen = mockBackend();

    const session = await signUpWithPassword(API, {
      name: 'Ada Lovelace',
      email: 'Ada@Example.com',
      password: 'correct horse battery staple',
    });

    expect(session.deviceId).toBe('device-uuid');
    expect(seen).toContain('/auth/signup');
    expect(seen).toContain('/devices/enroll');
    const stored = await loadSession();
    expect(stored?.userId).toBe('user-uuid');
    // Normalised on the way in, so the UI shows what the backend actually keyed
    // the account on rather than what the user happened to type.
    expect(stored?.email).toBe('ada@example.com');
    expect(stored?.name).toBe('Ada Lovelace');
  });

  it('signs in with a password and records the session', async () => {
    mockBackend();
    await signInWithPassword(API, { email: 'ada@example.com', password: 'correct horse battery' });
    expect((await loadSession())?.userId).toBe('user-uuid');
  });

  it('reports a taken address on signup', async () => {
    mockBackend({ oauthStatus: 409, oauthBody: JSON.stringify({ error: 'email_in_use' }) });
    await expect(
      signUpWithPassword(API, {
        name: 'Ada',
        email: 'ada@example.com',
        password: 'correct horse battery staple',
      }),
    ).rejects.toThrow(/already exists/i);
  });

  /**
   * The backend answers `invalid_credentials` for an unknown address, a wrong
   * password, and an account with no password alike. A UI that guessed between
   * them would rebuild the account-existence oracle the backend refuses to be,
   * so there is exactly one message.
   */
  it('says the same thing for every rejected credential', async () => {
    mockBackend({ oauthStatus: 401, oauthBody: JSON.stringify({ error: 'invalid_credentials' }) });
    await expect(
      signInWithPassword(API, { email: 'ada@example.com', password: 'wrong' }),
    ).rejects.toThrow(
      'That email and password do not match an account. Check the password, or create an account.',
    );
  });

  /**
   * The launch gate reads the session record. Writing it before enrollment
   * succeeds would put the app past its own gate with no enrolled device
   * behind it — a home screen whose every call fails.
   */
  it('records NO session when enrollment fails', async () => {
    globalThis.fetch = jest.fn((url: string) => {
      if (url.includes('/auth/')) {
        return Promise.resolve({
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                accessToken: 'account-token',
                expiresInSeconds: 600,
                refreshToken: 'account-refresh',
                userId: 'user-uuid',
              }),
            ),
        });
      }
      if (url.endsWith('/devices/challenge')) {
        return Promise.resolve({
          status: 201,
          text: () => Promise.resolve(JSON.stringify({ challenge: 'a-nonce' })),
        });
      }
      return Promise.resolve({ status: 409, text: () => Promise.resolve('{"error":"conflict"}') });
    }) as unknown as typeof fetch;

    await expect(
      signInWithPassword(API, { email: 'ada@example.com', password: 'correct horse battery' }),
    ).rejects.toThrow();
    expect(await loadSession()).toBeNull();
  });

  it('asks for a reset code and never says whether the address exists', async () => {
    const seen = mockBackend();
    await expect(requestPasswordReset(API, 'nobody@example.com')).resolves.toBeUndefined();
    expect(seen).toContain('/auth/password/reset/request');
  });

  it('reports an unavailable reset service rather than pretending', async () => {
    mockBackend({ oauthStatus: 503 });
    await expect(requestPasswordReset(API, 'ada@example.com')).rejects.toThrow(/not available/i);
  });

  it('spends a reset code on a new password and signs in', async () => {
    const seen = mockBackend();
    const session = await confirmPasswordReset(API, 'reset-code', 'a whole new passphrase');
    expect(session.deviceId).toBe('device-uuid');
    expect(seen).toContain('/auth/password/reset/confirm');
    expect((await loadSession())?.userId).toBe('user-uuid');
  });
});

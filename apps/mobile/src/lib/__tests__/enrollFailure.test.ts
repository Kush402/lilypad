import * as keychainModule from 'react-native-keychain';
import { signUpWithPassword } from '../signIn';
import { resetDeviceKeyCache, devicePublicKey } from '../identity';
import { resetAuthState, resetDeviceIdentity, DeviceTakenError } from '../auth';
import { resetSessionCacheForTests, loadSession } from '../session';
import { initDeviceIdentity, resetDeviceIdCacheForTests } from '../device';

/**
 * What a phone is told when its key already belongs to somebody else's
 * account — and how it gets out.
 *
 * The scenario is ordinary, not exotic: a person creates an account with a
 * mistyped address, signs out, and creates another one. `/devices/enroll`
 * answers 409 `device_owned_by_another_account`, because a device row may not
 * change hands (a phone inherits the previous owner's pairings if it does).
 * That refusal is correct. Leaving the phone with no way forward is not:
 * the key lives in the Keychain, which survives deleting the app, so without
 * a reset the phone can never be used with any other account again.
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

// `signIn.ts` pulls both SDKs in at module load, and neither has a native
// binary here. This file exercises none of them.
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn(), hasPlayServices: jest.fn(), signIn: jest.fn() },
}));
jest.mock('@invertase/react-native-apple-authentication', () => ({
  __esModule: true,
  default: {
    isSupported: false,
    performRequest: jest.fn(),
    Operation: { LOGIN: 1 },
    Scope: { EMAIL: 0, FULL_NAME: 1 },
    Error: { CANCELED: '1001' },
  },
}));

const keychain = keychainModule as unknown as { __reset: () => void };

const API = 'http://localhost:8080';
const SIGNUP = { name: 'Ben', email: 'ben@asu.edu', password: 'a-long-password' };

/** Signs up fine, then answers whatever the test says on `/devices/enroll`. */
function backend(enroll: { status: number; body: string }) {
  const enrolled: string[] = [];
  globalThis.fetch = jest.fn((url: string) => {
    if (url.includes('/auth/')) {
      return Promise.resolve({
        status: 201,
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
    enrolled.push(url);
    return Promise.resolve({ status: enroll.status, text: () => Promise.resolve(enroll.body) });
  }) as unknown as typeof fetch;
  return enrolled;
}

const TAKEN = {
  status: 409,
  body: JSON.stringify({
    error: 'device_owned_by_another_account',
    message: 'this device is already enrolled on another account',
  }),
};

const OK = {
  status: 200,
  body: JSON.stringify({
    accessToken: 'device-token',
    expiresInSeconds: 600,
    deviceId: 'device-uuid',
    userId: 'user-uuid',
  }),
};

beforeEach(() => {
  resetAuthState();
  resetDeviceKeyCache();
  resetDeviceIdCacheForTests();
  resetSessionCacheForTests();
  keychain.__reset();
  jest.clearAllMocks();
});

describe('a phone whose key belongs to another account', () => {
  it('is told what happened in a sentence, not in JSON', async () => {
    backend(TAKEN);

    const err = await signUpWithPassword(API, SIGNUP).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DeviceTakenError);
    const message = (err as Error).message;
    // The three ways the old raw throw leaked implementation into the UI.
    expect(message).not.toContain('HTTP');
    expect(message).not.toContain('{');
    expect(message).not.toContain('device_owned_by_another_account');
    // And it names the way out, because there is one.
    expect(message.toLowerCase()).toContain('different lilypad account');
  });

  it('is not left signed in when enrollment was refused', async () => {
    backend(TAKEN);

    await expect(signUpWithPassword(API, SIGNUP)).rejects.toThrow();

    // Being "signed in" means enrolled. A session record written anyway would
    // put the app past its own launch gate with a device the backend refuses.
    expect(await loadSession()).toBeNull();
  });

  it('can be reset into a genuinely new device, and then signs in', async () => {
    backend(TAKEN);
    await expect(signUpWithPassword(API, SIGNUP)).rejects.toThrow(DeviceTakenError);
    const oldKey = await devicePublicKey();
    const oldId = await initDeviceIdentity();

    await resetDeviceIdentity();

    // A new keypair AND a new id: the backend keys `devices` on both, so
    // reusing either would land on the same row and be refused again.
    expect(await devicePublicKey()).not.toBe(oldKey);
    expect(await initDeviceIdentity()).not.toBe(oldId);

    backend(OK);
    const session = await signUpWithPassword(API, SIGNUP);
    expect(session.deviceId).toBe('device-uuid');
    expect(await loadSession()).not.toBeNull();
  });

  it('does not offer the reset for a failure a reset cannot fix', async () => {
    backend({ status: 500, body: 'upstream exploded' });

    const err = await signUpWithPassword(API, SIGNUP).then(
      () => null,
      (e: unknown) => e,
    );

    // A new key would meet the same broken server. Offering "start over as a
    // new device" here would destroy an identity for nothing.
    expect(err).not.toBeInstanceOf(DeviceTakenError);
    expect((err as Error).message).not.toContain('upstream exploded');
  });
});

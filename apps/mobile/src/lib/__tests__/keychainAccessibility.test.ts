/**
 * Nothing this app writes to the Keychain may ride an iCloud or iTunes backup
 * onto a different phone.
 *
 * The device key was already pinned to WHEN_UNLOCKED_THIS_DEVICE_ONLY;
 * `pairs.ts` and `session.ts` were not, and `pairs.ts` holds `connectSecret` —
 * a bearer credential presented on every no-QR reconnect. Worse than the
 * credential leaving the device was the incoherence it created: a restored
 * phone would show a list of paired Macs with no device key to reach them, so
 * the user sees their computers, taps one, and it fails with nothing to
 * explain why. A restored backup should start empty, which is what already
 * happened to the identity.
 *
 * Asserted rather than left to review, because the failure is invisible:
 * omitting the option is not an error, it silently picks the weaker class.
 */
const calls: Array<{ service?: string; accessible?: string }> = [];

jest.mock('react-native-keychain', () => {
  const store = new Map<string, { username: string; password: string }>();
  const key = (options?: { service?: string }) => options?.service ?? 'default';
  return {
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
    getGenericPassword: jest.fn((options?: { service?: string }) =>
      Promise.resolve(store.get(key(options)) ?? false),
    ),
    setGenericPassword: jest.fn(
      (username: string, password: string, options?: { service?: string; accessible?: string }) => {
        calls.push({ service: options?.service, accessible: options?.accessible });
        store.set(key(options), { username, password });
        return Promise.resolve(true);
      },
    ),
    resetGenericPassword: jest.fn(() => Promise.resolve(true)),
  };
});

import { upsertPair, setPairSecret } from '../pairs';
import { saveSession } from '../session';
import { initDeviceKey, resetDeviceKeyCache } from '../identity';
import { saveResumeHandle, resetResumeHandleCache } from '../sessionResume';

describe('every Keychain write is THIS_DEVICE_ONLY', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  const assertAllPinned = () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.accessible).toBe('WhenUnlockedThisDeviceOnly');
    }
  };

  it('pairs.ts — the store that holds connectSecret', async () => {
    await upsertPair({
      desktopDeviceId: 'desk-1',
      name: 'a MacBook',
      apiBaseUrl: 'https://api.takedia.com',
    });
    await setPairSecret('desk-1', 'a-bearer-secret');
    assertAllPinned();
  });

  it('session.ts — the signed-in record', async () => {
    await saveSession({ userId: 'u-1', apiBaseUrl: 'https://api.takedia.com' });
    assertAllPinned();
  });

  it('identity.ts — the device key, which was already correct', async () => {
    resetDeviceKeyCache();
    await initDeviceKey();
    assertAllPinned();
  });

  it('sessionResume.ts — the reopen handle is not a secret, but still this-device-only', async () => {
    resetResumeHandleCache();
    await saveResumeHandle({ desktopDeviceId: 'desk-1' });
    assertAllPinned();
  });
});

import * as keychainModule from 'react-native-keychain';
import { accessToken, resetAuthState, DeviceAuthError } from '../auth';
import { resetDeviceKeyCache } from '../identity';
import { saveSession, resetSessionCacheForTests } from '../session';
import { redeemToken } from '../api';
import { deviceProofMessage } from '@lilypad/protocol';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { devicePublicKey, fromBase64Url, utf8 } from '../identity';

ed.hashes.sha512 = sha512;

/** The host, or the raw string when there is none — one test deliberately
 * passes a base URL that is not a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Verify a signature the app produced, the way the backend would. */
async function verifies(publicKey: string, message: string, signature: string): Promise<boolean> {
  return ed.verify(fromBase64Url(signature), utf8(message), fromBase64Url(publicKey));
}

/**
 * A scanned QR names the backend the phone will talk to, and a QR is the one
 * thing this product has trained its users to scan without thinking.
 *
 * The token cache was a single module-level slot that ignored the URL it was
 * asked for, so `accessToken('https://evil.example')` handed back the token
 * minted for the real backend — and `redeemToken` put it straight into an
 * `Authorization` header aimed at whatever host the code named. One scan, no
 * prompt, and a stranger holds a live device token for the user's account:
 * enough to list their laptops, and enough to approve an enrollment code and
 * put a machine of their own on the account permanently.
 *
 * The rule these tests hold to is stronger than "key the cache": a device
 * credential is only ever sent to the backend this phone is enrolled on.
 * Minting a FRESH token for a foreign host would be just as bad — that host
 * can relay a challenge from the real backend and get the phone to sign it.
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

const keychain = keychainModule as unknown as { __reset: () => void };

const HOME = 'https://api.takedia.example';
const EVIL = 'https://evil.example';

/** Answers the device challenge/token exchange for any host, and records
 * every request so the test can see where credentials actually went. */
function backend() {
  const seen: { url: string; authorization?: string; body?: string }[] = [];
  globalThis.fetch = jest.fn(
    (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      seen.push({ url, authorization: init?.headers?.authorization, body: init?.body });
      if (url.endsWith('/devices/challenge')) {
        return Promise.resolve({
          status: 201,
          text: () => Promise.resolve(JSON.stringify({ challenge: 'a-nonce-abcdefgh' })),
        });
      }
      if (url.endsWith('/devices/token')) {
        return Promise.resolve({
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                // Names the host so a test can see WHICH server minted it.
                // Tolerates a base URL with no host, which one test uses.
                accessToken: `token-for-${hostOf(url)}`,
                expiresInSeconds: 600,
                deviceId: 'device-uuid',
                userId: 'user-uuid',
              }),
            ),
        });
      }
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ roomId: 'r', signalingUrl: 'wss://x/ws', scopes: ['view'] }),
        text: () => Promise.resolve('{}'),
      });
    },
  ) as unknown as typeof fetch;
  return seen;
}

beforeEach(async () => {
  resetAuthState();
  resetDeviceKeyCache();
  resetSessionCacheForTests();
  keychain.__reset();
  jest.clearAllMocks();
  await saveSession({ userId: 'user-uuid', apiBaseUrl: HOME });
});

describe('a device credential never leaves its own backend', () => {
  it('serves the home backend normally', async () => {
    backend();
    expect(await accessToken(HOME)).toBe('token-for-api.takedia.example');
    // Cached, not re-minted.
    expect(await accessToken(HOME)).toBe('token-for-api.takedia.example');
  });

  it('tolerates a trailing slash rather than treating it as another host', async () => {
    backend();
    await accessToken(HOME);
    expect(await accessToken(`${HOME}/`)).toBe('token-for-api.takedia.example');
  });

  it('refuses to hand the cached token to a different backend', async () => {
    backend();
    await accessToken(HOME);

    await expect(accessToken(EVIL)).rejects.toBeInstanceOf(DeviceAuthError);
  });

  it('refuses to mint a fresh one there either — that is a signing oracle', async () => {
    const seen = backend();

    await expect(accessToken(EVIL)).rejects.toBeInstanceOf(DeviceAuthError);

    // Not one request to the foreign host: no challenge fetched, and above
    // all nothing signed. A host that can get this phone to sign a challenge
    // can relay one from the real backend and replay the signature there.
    expect(seen.filter((r) => r.url.startsWith(EVIL))).toEqual([]);
  });

  it('sends no Authorization header to a host named by a scanned QR', async () => {
    const seen = backend();
    await accessToken(HOME);

    // `redeemToken` is what a scan calls, with the URL the QR supplied.
    await redeemToken(EVIL, 'a-scanned-token').catch(() => undefined);

    const leaked = seen.filter((r) => r.url.startsWith(EVIL) && r.authorization);
    expect(leaked).toEqual([]);
  });
});

describe('the proof names the server it is for', () => {
  it('sends the host alongside the signature', async () => {
    const seen = backend();
    await accessToken(HOME);

    const token = seen.find((r) => r.url.endsWith('/devices/token'));
    expect(JSON.parse(token!.body!).proofOrigin).toBe('api.takedia.example');
  });

  it('signs the host, not just the challenge', async () => {
    const seen = backend();
    await accessToken(HOME);
    const sent = JSON.parse(seen.find((r) => r.url.endsWith('/devices/token'))!.body!);

    // The signature must verify over the v2 message and NOT over the v1 one:
    // a proof that also verifies as v1 could be replayed at a server that
    // still accepts the old form, which is every server today.
    const key = await devicePublicKey();
    expect(
      await verifies(key, deviceProofMessage(sent.challenge, sent.proofOrigin), sent.signature),
    ).toBe(true);
    expect(await verifies(key, deviceProofMessage(sent.challenge), sent.signature)).toBe(false);
  });

  it('falls back to the older message when the address has no host', async () => {
    // Degrading beats refusing: an unparseable base URL is a client bug, and
    // a phone that cannot authenticate at all is a worse outcome than one
    // that authenticates the way every shipped build already does.
    resetAuthState();
    resetSessionCacheForTests();
    await saveSession({ userId: 'user-uuid', apiBaseUrl: 'not-a-url' });
    const seen = backend();

    await accessToken('not-a-url');

    const sent = JSON.parse(seen.find((r) => r.url.endsWith('/devices/token'))!.body!);
    expect(sent.proofOrigin).toBeUndefined();
    const key = await devicePublicKey();
    expect(await verifies(key, deviceProofMessage(sent.challenge), sent.signature)).toBe(true);
  });
});

import * as ed from '@noble/ed25519';
import { DEVICE_AUTH_PREFIX } from '@lilypad/protocol';
import {
  toBase64Url,
  fromBase64Url,
  utf8,
  initDeviceKey,
  devicePublicKey,
  signChallenge,
  resetDeviceKeyCache,
  hasDeviceKey,
} from '../identity';

jest.mock('react-native-keychain', () => {
  let stored: { username: string; password: string } | null = null;
  return {
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
    getGenericPassword: jest.fn(() => Promise.resolve(stored ?? false)),
    setGenericPassword: jest.fn((username: string, password: string) => {
      stored = { username, password };
      return Promise.resolve(true);
    }),
    __reset: () => {
      stored = null;
    },
    __peek: () => stored,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const keychain = require('react-native-keychain') as {
  __reset: () => void;
  __peek: () => { username: string; password: string } | null;
  setGenericPassword: jest.Mock;
  getGenericPassword: jest.Mock;
};

beforeEach(() => {
  keychain.__reset();
  resetDeviceKeyCache();
  jest.clearAllMocks();
});

/**
 * The encoders are hand-written because React Native does not guarantee
 * `btoa`/`atob`/`TextEncoder`. Node DOES have correct implementations, so these
 * tests check ours against a known-good oracle rather than against themselves.
 *
 * `Buffer` is declared locally rather than by pulling `@types/node` into the
 * app's tsconfig: Node's globals would shadow React Native's (`setTimeout`
 * returning a `NodeJS.Timeout`, for one) across the whole codebase, which is a
 * large blast radius for a two-line test oracle. Jest runs on Node, so it
 * exists at runtime.
 */
declare const Buffer: {
  from(
    input: Uint8Array | string,
    encoding?: string,
  ): Uint8Array & {
    toString(encoding: string): string;
  };
};

describe('base64url', () => {
  const oracle = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

  it.each([0, 1, 2, 3, 4, 5, 31, 32, 63, 64, 65])('matches Node for a %i-byte input', (length) => {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
    expect(toBase64Url(bytes)).toBe(oracle(bytes));
  });

  it('covers every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toBase64Url(bytes)).toBe(oracle(bytes));
  });

  it('emits no padding and no + or /', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
  });

  it.each([0, 1, 15, 31, 32, 64])('round-trips a %i-byte input', (length) => {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 91 + 7) % 256);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
  });

  it('rejects input that is not base64url', () => {
    expect(() => fromBase64Url('has spaces')).toThrow(/base64url/);
  });
});

describe('utf8', () => {
  const oracle = (text: string) => Array.from(Buffer.from(text, 'utf8'));

  it.each(['plain-ascii', 'lilypad-device-auth:v1:abc_-123', 'café', '日本語', '🪷 lilypad'])(
    'matches Node for %j',
    (text) => {
      expect(Array.from(utf8(text))).toEqual(oracle(text));
    },
  );
});

describe('device key', () => {
  it('generates and persists a 32-byte key on first use', async () => {
    const secret = await initDeviceKey();
    expect(secret).toHaveLength(32);
    expect(keychain.setGenericPassword).toHaveBeenCalledTimes(1);
  });

  // A key that never leaves the phone must also never ride a backup onto a
  // different one — a restored duplicate would be a second device holding the
  // first one's credential.
  it('stores the key as this-device-only, so it cannot ride a backup', async () => {
    await initDeviceKey();
    expect(keychain.setGenericPassword).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ accessible: 'WhenUnlockedThisDeviceOnly' }),
    );
  });

  it('reuses the stored key across restarts', async () => {
    const first = await devicePublicKey();
    resetDeviceKeyCache();
    expect(await devicePublicKey()).toBe(first);
    expect(keychain.setGenericPassword).toHaveBeenCalledTimes(1);
  });

  it('shares one keychain round-trip between concurrent callers', async () => {
    const [a, b, c] = await Promise.all([initDeviceKey(), initDeviceKey(), initDeviceKey()]);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(Array.from(c)).toEqual(Array.from(a));
    expect(keychain.getGenericPassword).toHaveBeenCalledTimes(1);
  });

  // Silently replacing an unreadable key would orphan this phone's enrollment
  // and its trust relationships, so it must surface instead.
  it('refuses a stored value of the wrong length', async () => {
    keychain.getGenericPassword.mockResolvedValueOnce({
      username: 'x',
      password: toBase64Url(new Uint8Array(16)),
    });
    await expect(initDeviceKey()).rejects.toThrow(/wrong length/);
  });

  it('does not memoize a failure, so a transient keychain error is retryable', async () => {
    keychain.getGenericPassword.mockRejectedValueOnce(new Error('keychain locked'));
    await expect(initDeviceKey()).rejects.toThrow('keychain locked');
    await expect(initDeviceKey()).resolves.toHaveLength(32);
  });

  it('reports whether a key is loaded', async () => {
    expect(hasDeviceKey()).toBe(false);
    await initDeviceKey();
    expect(hasDeviceKey()).toBe(true);
  });
});

describe('signing', () => {
  it('produces a 43-character public key and an 86-character signature', async () => {
    expect(await devicePublicKey()).toHaveLength(43);
    expect(await signChallenge('a-challenge')).toHaveLength(86);
  });

  it('produces a signature its own public key verifies', async () => {
    const challenge = 'a-server-issued-challenge';
    const signature = fromBase64Url(await signChallenge(challenge));
    const publicKey = fromBase64Url(await devicePublicKey());
    expect(ed.verify(signature, utf8(`${DEVICE_AUTH_PREFIX}${challenge}`), publicKey)).toBe(true);
  });

  // Domain separation: the same key binds the desktop's LAN TLS certificate in
  // ADR-0006, so a signature made for that purpose must not authenticate here.
  it('signs the prefixed message, not the bare challenge', async () => {
    const challenge = 'a-server-issued-challenge';
    const signature = fromBase64Url(await signChallenge(challenge));
    const publicKey = fromBase64Url(await devicePublicKey());
    expect(ed.verify(signature, utf8(challenge), publicKey)).toBe(false);
  });

  it('produces a different signature for a different challenge', async () => {
    expect(await signChallenge('challenge-a')).not.toBe(await signChallenge('challenge-b'));
  });
});

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { redisKeys } from '@lilypad/shared';
import { DEVICE_AUTH_PREFIX } from '@lilypad/protocol';
import {
  createDeviceChallenge,
  consumeDeviceChallenge,
  verifyDeviceSignature,
  type DeviceChallengeRedis,
} from './deviceIdentity.js';

/** A device's keypair, in the wire encoding the protocol specifies: raw
 * 32-byte public key as base64url, exactly a JWK `x` value. */
function newDevice(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { publicKey: jwk.x, privateKey };
}

function signChallenge(privateKey: KeyObject, challenge: string): string {
  return sign(null, Buffer.from(`${DEVICE_AUTH_PREFIX}${challenge}`, 'utf8'), privateKey).toString(
    'base64url',
  );
}

function fakeRedis(): DeviceChallengeRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set(key, value) {
      store.set(key, value);
      return Promise.resolve('OK');
    },
    getdel(key) {
      const value = store.get(key) ?? null;
      store.delete(key);
      return Promise.resolve(value);
    },
  };
}

describe('device challenges', () => {
  it('issues a challenge under its own key with a TTL', async () => {
    const redis = fakeRedis();
    const { challenge, expiresInSeconds } = await createDeviceChallenge(redis);
    expect(redis.store.has(redisKeys.deviceChallenge(challenge))).toBe(true);
    expect(expiresInSeconds).toBeGreaterThan(0);
  });

  it('mints a distinct challenge each time', async () => {
    const redis = fakeRedis();
    const first = await createDeviceChallenge(redis);
    const second = await createDeviceChallenge(redis);
    expect(second.challenge).not.toBe(first.challenge);
  });

  // Single-use is what bounds replay: the nonce is gone the instant it is
  // spent, so an observed signature cannot be presented twice.
  it('can be consumed exactly once', async () => {
    const redis = fakeRedis();
    const { challenge } = await createDeviceChallenge(redis);
    expect(await consumeDeviceChallenge(challenge, redis)).toBe(true);
    expect(await consumeDeviceChallenge(challenge, redis)).toBe(false);
  });

  it('refuses a challenge it never issued', async () => {
    expect(await consumeDeviceChallenge('made-up-challenge', fakeRedis())).toBe(false);
  });
});

describe('verifyDeviceSignature', () => {
  it('accepts a signature the matching private key produced', () => {
    const device = newDevice();
    const challenge = 'a-server-issued-challenge';
    expect(
      verifyDeviceSignature(
        device.publicKey,
        challenge,
        signChallenge(device.privateKey, challenge),
      ),
    ).toBe(true);
  });

  it('rejects another device signing the same challenge', () => {
    const device = newDevice();
    const impostor = newDevice();
    const challenge = 'a-server-issued-challenge';
    expect(
      verifyDeviceSignature(
        device.publicKey,
        challenge,
        signChallenge(impostor.privateKey, challenge),
      ),
    ).toBe(false);
  });

  it('rejects a signature over a different challenge', () => {
    const device = newDevice();
    expect(
      verifyDeviceSignature(
        device.publicKey,
        'challenge-b',
        signChallenge(device.privateKey, 'challenge-a'),
      ),
    ).toBe(false);
  });

  // Domain separation: the same key also binds the desktop's LAN TLS
  // certificate (ADR-0006), so a signature made for another purpose — even
  // over the identical challenge string — must not authenticate a device.
  it('rejects a signature made without the domain-separation prefix', () => {
    const device = newDevice();
    const challenge = 'a-server-issued-challenge';
    const undomained = sign(null, Buffer.from(challenge, 'utf8'), device.privateKey).toString(
      'base64url',
    );
    expect(verifyDeviceSignature(device.publicKey, challenge, undomained)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const device = newDevice();
    const challenge = 'a-server-issued-challenge';
    const good = Buffer.from(signChallenge(device.privateKey, challenge), 'base64url');
    good[0] ^= 0xff;
    expect(verifyDeviceSignature(device.publicKey, challenge, good.toString('base64url'))).toBe(
      false,
    );
  });

  it('rejects a signature of the wrong length rather than letting it reach the verifier', () => {
    const device = newDevice();
    const challenge = 'a-server-issued-challenge';
    const truncated = Buffer.from(signChallenge(device.privateKey, challenge), 'base64url')
      .subarray(0, 32)
      .toString('base64url');
    expect(verifyDeviceSignature(device.publicKey, challenge, truncated)).toBe(false);
  });

  it.each([
    ['empty key', '', 'AAAA'],
    ['garbage key', 'not-a-key', 'AAAA'],
    ['garbage signature', undefined, '!!!not-base64url!!!'],
  ])('returns false rather than throwing for %s', (_label, key, signature) => {
    const device = newDevice();
    expect(() =>
      verifyDeviceSignature(key ?? device.publicKey, 'challenge', signature),
    ).not.toThrow();
    expect(verifyDeviceSignature(key ?? device.publicKey, 'challenge', signature)).toBe(false);
  });
});

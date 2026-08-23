import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as edSign, type createPrivateKey } from 'node:crypto';
import { deviceProofMessage, DEVICE_AUTH_PREFIX, DEVICE_AUTH_PREFIX_V2 } from '@lilypad/protocol';
import { verifyDeviceSignature } from './deviceIdentity.js';

/**
 * The relay this exists to stop (L-30).
 *
 * A v1 proof is a signature over a purpose and a nonce and nothing else, so a
 * hostile server can fetch a challenge from the real backend, hand it to a
 * device as if it were its own, and replay the resulting signature. Nothing in
 * the signed bytes says who the proof was for.
 *
 * v2 puts the host inside the signature. These tests are about the property
 * that follows: a proof made for one server does not verify at another.
 */

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  return { privateKey, publicKey: Buffer.from(raw).toString('base64url') };
}

/** Sign exactly what a client of the given version would sign. */
function signProof(
  privateKey: ReturnType<typeof createPrivateKey>,
  challenge: string,
  origin?: string,
) {
  const message = Buffer.from(deviceProofMessage(challenge, origin), 'utf8');
  return Buffer.from(edSign(null, message, privateKey)).toString('base64url');
}

const CHALLENGE = 'a-real-server-issued-nonce-abcdefgh';

describe('a device proof that names its server', () => {
  it('verifies at the server it was made for', () => {
    const key = keypair();
    const sig = signProof(key.privateKey, CHALLENGE, 'api.takedia.com');

    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, sig, 'api.takedia.com')).toBe(true);
  });

  it('does NOT verify when replayed at a different server', () => {
    const key = keypair();
    // The phone was talking to evil.example and signed so. The attacker takes
    // that signature to the real backend, which checks it against its own
    // host — the whole attack, and the whole defence.
    const sig = signProof(key.privateKey, CHALLENGE, 'evil.example');

    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, sig, 'api.takedia.com')).toBe(false);
  });

  it('does not let a v1 signature pass as a v2 one', () => {
    const key = keypair();
    // The downgrade an attacker would reach for: present an old-style
    // signature and claim it was for this host.
    const v1 = signProof(key.privateKey, CHALLENGE);

    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, v1, 'api.takedia.com')).toBe(false);
  });

  it('does not let a v2 signature pass as a v1 one either', () => {
    const key = keypair();
    const v2 = signProof(key.privateKey, CHALLENGE, 'api.takedia.com');

    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, v2)).toBe(false);
  });

  it('still accepts a v1 proof from a client that has not been updated', () => {
    // Both forms are accepted until the fleet has moved. Breaking this would
    // sign every installed build out of its own account.
    const key = keypair();
    const v1 = signProof(key.privateKey, CHALLENGE);

    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, v1)).toBe(true);
  });

  it('binds the whole host, port included', () => {
    const key = keypair();
    const sig = signProof(key.privateKey, CHALLENGE, 'lan.local:8080');

    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, sig, 'lan.local:8080')).toBe(true);
    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, sig, 'lan.local:9090')).toBe(false);
    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, sig, 'lan.local')).toBe(false);
  });
});

describe('the two message formats', () => {
  it('are distinguished by a prefix, so neither can be read as the other', () => {
    expect(DEVICE_AUTH_PREFIX).not.toBe(DEVICE_AUTH_PREFIX_V2);

    // Literals, deliberately, not the constants. `identity.rs` builds these
    // same two strings by hand — the desktop cannot import this module — and
    // the pair of literal assertions is what catches the two implementations
    // drifting apart. A mismatch is not subtle: the server refuses the
    // signature, and the Mac can never sign in.
    expect(deviceProofMessage('nonce')).toBe('lilypad-device-auth:v1:nonce');
    expect(deviceProofMessage('nonce', 'h.example')).toBe(
      'lilypad-device-auth:v2:9:h.example:nonce',
    );
  });

  it('treats a null origin as v1, so an unparseable base URL degrades safely', () => {
    expect(deviceProofMessage('nonce', null)).toBe(`${DEVICE_AUTH_PREFIX}nonce`);
  });

  it('cannot be confused by a host that contains the separator', () => {
    // Caught while writing this file: joining with a bare colon made
    // `host "a:1" + challenge "n"` and `host "a" + challenge "1:n"` the same
    // bytes — one signature meaning two things. The length prefix is what
    // makes the encoding canonical.
    expect(deviceProofMessage('n', 'a:1')).not.toBe(deviceProofMessage('1:n', 'a'));
    expect(deviceProofMessage('n', 'a:1')).toBe(`${DEVICE_AUTH_PREFIX_V2}3:a:1:n`);
  });
});

/**
 * Dropping v1 is a deployment step, not a code change — see
 * `REQUIRE_DEVICE_PROOF_ORIGIN`. These pin the two halves of the reason it is
 * a flag: turning it on must refuse an un-updated client, and leaving it off
 * must not.
 *
 * The route-level behaviour is covered end-to-end by `e2e-proof-required`
 * against a real backend; this is the decision itself.
 */
describe('requiring the origin-bound form', () => {
  it('is what actually closes the relay', () => {
    // With v1 still accepted, an attacker holding a relayed v1 signature can
    // present it instead of the v2 one they could not forge. Adding v2 does
    // not remove that option; refusing v1 does.
    const key = keypair();
    const relayedV1 = signProof(key.privateKey, CHALLENGE);

    // Still a perfectly valid v1 proof — which is the problem.
    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, relayedV1)).toBe(true);
    // ...and useless the moment the server stops asking the v1 question.
    expect(verifyDeviceSignature(key.publicKey, CHALLENGE, relayedV1, 'api.takedia.com')).toBe(
      false,
    );
  });
});

import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { redisKeys } from '@lilypad/shared';
import { deviceProofMessage } from '@lilypad/protocol';
import { redis } from '../redis.js';

/**
 * Proof that a caller holds a device's Ed25519 private key
 * ([ADR-0002](../../../../docs/adr/0002-device-identity.md)).
 *
 * Three properties, each of which is a separate attack if missing:
 *
 * - **The server picks the challenge.** A client-chosen nonce lets an attacker
 *   who once observed a signature choose the same input again.
 * - **The challenge is single-use** (`GETDEL`) **and short-lived.** Together
 *   these bound replay to a window that does not exist in practice: the nonce
 *   is gone the instant it is spent.
 * - **What is signed is domain-separated.** The same key also binds the
 *   desktop's LAN TLS certificate (ADR-0006), so a prefix keeps a signature
 *   made for one purpose from being valid for the other.
 *
 * Ed25519 verification is `node:crypto` — no dependency needed. Keys arrive as
 * raw 32-byte base64url, which is exactly a JWK `x` value, so importing via JWK
 * avoids hand-assembling SPKI DER.
 */

/** Long enough for a slow round-trip on a bad connection, short enough that an
 * unspent challenge is not a standing opportunity. */
export const DEVICE_CHALLENGE_TTL_SECONDS = 120;

/** The slice of Redis this needs — injectable for tests, matching
 * `PairingRedis` and `MagicLinkRedis`. */
export interface DeviceChallengeRedis {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/** Issue a single-use challenge for a device to sign. */
export async function createDeviceChallenge(
  client: DeviceChallengeRedis = redis,
): Promise<{ challenge: string; expiresInSeconds: number }> {
  const challenge = randomBytes(32).toString('base64url');
  await client.set(redisKeys.deviceChallenge(challenge), '1', 'EX', DEVICE_CHALLENGE_TTL_SECONDS);
  return { challenge, expiresInSeconds: DEVICE_CHALLENGE_TTL_SECONDS };
}

/** Burn a challenge. True only if this call is the one that spent it — two
 * concurrent attempts on the same challenge cannot both succeed. */
export async function consumeDeviceChallenge(
  challenge: string,
  client: DeviceChallengeRedis = redis,
): Promise<boolean> {
  return (await client.getdel(redisKeys.deviceChallenge(challenge))) !== null;
}

/**
 * Does `signature` verify as this key's signature over this challenge?
 *
 * Pure and synchronous: it does NOT consume the challenge, because a caller
 * must be able to burn the challenge first and then check the signature —
 * otherwise a wrong signature leaves the nonce spendable and the attacker gets
 * unlimited attempts against it.
 *
 * Returns false rather than throwing on malformed keys or signatures: a
 * caller's only correct response to "this did not verify" is the same either
 * way, and distinguishing "bad key encoding" from "bad signature" tells an
 * attacker which half to fix.
 *
 * `proofOrigin`, when given, is the host the client named and therefore signed
 * (v2 — see `deviceProofMessage`). **The caller must already have checked that
 * the host is one of this server's own** (`isProofOriginAllowed`); this
 * function only decides whether the bytes verify, and verifying a signature
 * over `evil.example` would succeed perfectly well.
 *
 * Absent, the v1 message is checked instead, so a client that predates the
 * change keeps working. Both are accepted until the fleet has moved — which
 * `devices.app_version` now makes measurable.
 */
export function verifyDeviceSignature(
  publicKeyBase64Url: string,
  challenge: string,
  signatureBase64Url: string,
  proofOrigin?: string | null,
): boolean {
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBase64Url },
      format: 'jwk',
    });
    const message = Buffer.from(deviceProofMessage(challenge, proofOrigin), 'utf8');
    const signature = Buffer.from(signatureBase64Url, 'base64url');
    // Ed25519 signatures are exactly 64 bytes. base64url decoding is lenient
    // about trailing garbage, so an explicit length check stops a malformed
    // input from reaching the verifier at all.
    if (signature.length !== 64) return false;
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

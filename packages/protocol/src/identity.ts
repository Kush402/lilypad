import { z } from 'zod';
import { DeviceKindSchema, PlatformSchema } from './pairing.js';

/**
 * REST contract for device identity (M8,
 * [ADR-0002](../../../docs/adr/0002-device-identity.md)).
 *
 * A device proves who it is by signing a server-issued challenge with an
 * Ed25519 private key that never leaves it. The self-asserted `deviceId`
 * string keeps existing as a human-facing label and as `devices.fingerprint`,
 * but it stops being the thing anything trusts.
 *
 * Devices renew by signing a fresh challenge rather than by holding a refresh
 * token. That is the point of having a key: the durable credential is a
 * non-exportable, hardware-backed private key instead of a bearer string that
 * grants device access to whoever copies it.
 */

/** Raw Ed25519 public key, base64url, 32 bytes → 43 base64url characters. */
export const PublicKeySchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

/** Raw Ed25519 signature, base64url, 64 bytes → 86 base64url characters. */
export const SignatureSchema = z
  .string()
  .length(86)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

/** Domain separation for what a device signs. The same key also binds the
 * desktop's LAN TLS certificate ([ADR-0006](../../../docs/adr/0006-lan-first-connectivity.md)),
 * so a signature produced for one purpose must not be replayable as the
 * other. Clients sign `DEVICE_AUTH_PREFIX + challenge` as UTF-8 bytes. */
export const DEVICE_AUTH_PREFIX = 'lilypad-device-auth:v1:';

/** A server-issued, single-use, short-lived nonce. */
export const DeviceChallengeSchema = z.object({
  /** base64url; the exact string to append to `DEVICE_AUTH_PREFIX`. */
  challenge: z.string().min(16).max(128),
  expiresInSeconds: z.number().int().positive(),
});
export type DeviceChallenge = z.infer<typeof DeviceChallengeSchema>;

/** The three fields every proof-of-possession carries. */
const proofFields = {
  challenge: z.string().min(16).max(128),
  publicKey: PublicKeySchema,
  signature: SignatureSchema,
};

/**
 * Bind a device to the signed-in account. Requires an account access token —
 * this is the moment a device gains an owner, so there must be an owner
 * present to gain.
 */
export const DeviceEnrollRequestSchema = z.object({
  ...proofFields,
  kind: DeviceKindSchema,
  /** The device's existing self-asserted id, kept as `devices.fingerprint` so
   * historical trust rows still resolve. */
  fingerprint: z.string().min(8).max(128),
  name: z.string().min(1).max(120).nullish(),
  platform: PlatformSchema.nullish(),
});
export type DeviceEnrollRequest = z.infer<typeof DeviceEnrollRequestSchema>;

/** Exchange proof of key possession for a device access token. No account
 * token needed: the key IS the credential, and the account it belongs to was
 * fixed at enrollment. */
export const DeviceTokenRequestSchema = z.object(proofFields);
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequestSchema>;

/** What enrollment and device sign-in both return. */
export const DeviceSessionSchema = z.object({
  accessToken: z.string(),
  expiresInSeconds: z.number().int().positive(),
  /** `devices.id` — a real server-side uuid, not the self-asserted string. */
  deviceId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type DeviceSession = z.infer<typeof DeviceSessionSchema>;

/** Machine-readable failure codes the device-identity endpoints return. */
export type DeviceIdentityErrorCode =
  | 'invalid_request'
  | 'invalid_signature'
  | 'device_not_enrolled'
  | 'device_revoked'
  | 'device_owned_by_another_account'
  | 'public_key_in_use';

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

// ── Desktop enrollment via an authenticated phone (M8) ───────────────────────

/**
 * The desktop has no OAuth client of its own
 * ([ADR-0008](../../../docs/adr/0008-desktop-enrollment-via-phone.md)). It is
 * enrolled by a phone that is already signed in, using the QR surface the
 * desktop already has — the WhatsApp Web / Steam model.
 *
 * This exists because Google removed the implicit ID-token flow for installed
 * apps: a desktop app can only obtain a Google ID token by exchanging an
 * authorization code, which would put a code exchange into a product that has
 * deliberately avoided one everywhere else. Borrowing the phone's session
 * avoids the exchange, the extra OAuth client, and the browser round-trip
 * entirely.
 */

/** The desktop asks for an enrollment code, proving it holds the key that the
 * code will be bound to. Unauthenticated by necessity — an unenrolled desktop
 * has no token yet, which is the whole point. */
export const DesktopEnrollmentCodeRequestSchema = z.object({
  ...proofFields,
  fingerprint: z.string().min(8).max(128),
  name: z.string().min(1).max(120).nullish(),
  platform: PlatformSchema.nullish(),
});
export type DesktopEnrollmentCodeRequest = z.infer<typeof DesktopEnrollmentCodeRequestSchema>;

/** What the desktop renders as a QR for the phone to scan. */
export const DesktopEnrollmentCodeSchema = z.object({
  code: z.string().min(16).max(128),
  expiresInSeconds: z.number().int().positive(),
});
export type DesktopEnrollmentCode = z.infer<typeof DesktopEnrollmentCodeSchema>;

/** The QR payload itself. `deviceName`/`platform` are shown to the user before
 * they approve — they are supplied by the DESKTOP, so they are a label to help
 * a human recognise their own machine, never an authorization input. */
export const DesktopEnrollmentQrSchema = z.object({
  v: z.literal(1),
  kind: z.literal('desktop-enrollment'),
  code: z.string().min(16).max(128),
  apiBaseUrl: z.string().url(),
  deviceName: z.string().max(120).nullable(),
  platform: PlatformSchema.nullable(),
});
export type DesktopEnrollmentQr = z.infer<typeof DesktopEnrollmentQrSchema>;

/** The phone approves, presenting its own DEVICE token. The account the
 * desktop joins is the token's subject — never anything in this body. */
export const DesktopEnrollmentApproveSchema = z.object({
  code: z.string().min(16).max(128),
});
export type DesktopEnrollmentApprove = z.infer<typeof DesktopEnrollmentApproveSchema>;

/**
 * What the phone gets back when it approves a laptop.
 *
 * `pairSecret` is delivered exactly once and never stored in plaintext
 * server-side. It is what the phone presents to `/connect/request` later, so a
 * phone that discards it can see the laptop but not reach it — the same
 * one-time delivery contract as `/pairing/redeem`.
 */
export const DesktopEnrollmentApprovedSchema = z.object({
  ok: z.literal(true),
  /** The newly linked desktop's `devices.id`. */
  deviceId: z.string(),
  /** Display name the desktop supplied at mint time. A label for a human to
   * recognise their own machine, never an authorization input. */
  name: z.string().nullable(),
  platform: PlatformSchema.nullable(),
  pairSecret: z.string(),
});
export type DesktopEnrollmentApproved = z.infer<typeof DesktopEnrollmentApprovedSchema>;

/**
 * A device's lifecycle state, as the clients render it.
 *
 * The distinction the product rests on: an account never discovers devices.
 * A desktop that has signed in is still `unlinked` until the explicit linking
 * ceremony binds it to that account, and both clients must be able to say so
 * honestly rather than implying availability.
 */
export const DeviceStateSchema = z.enum(['unlinked', 'linked', 'revoked']);
export type DeviceState = z.infer<typeof DeviceStateSchema>;

/** Machine-readable failures for the desktop-enrollment exchange. */
export type DesktopEnrollmentErrorCode =
  'invalid_signature' | 'invalid_code' | 'device_owned_by_another_account' | 'public_key_in_use';

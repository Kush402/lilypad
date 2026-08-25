import { z } from 'zod';
import { DeviceKindSchema, PlatformSchema, WireDeviceIdSchema } from './pairing.js';

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

// `WireDeviceIdSchema` lives in `pairing.ts` — the module with no imports of
// its own — and is re-exported here, where it was declared and is still
// imported from. `identity.ts` already imports `pairing.ts`, so declaring it
// here and importing it there would be a cycle, and a cycle whose failure mode
// is a schema that is `undefined` at module-init time depending on which entry
// point loaded first.
export { WireDeviceIdSchema } from './pairing.js';

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

/**
 * The same, but naming the server the proof is for.
 *
 * v1 binds a signature to a purpose and a nonce, and to nothing else — so a
 * host that can get a device to sign a challenge can relay one it obtained
 * from the real backend and replay the signature there. The remedy is to put
 * the server inside the signed bytes: a signature made for `evil.example`
 * says so, and `api.takedia.com` will not accept it.
 *
 * A separate prefix rather than an extra field inside the v1 message, so no
 * v2 message can ever be reinterpreted as a v1 message or the reverse.
 */
export const DEVICE_AUTH_PREFIX_V2 = 'lilypad-device-auth:v2:';

/**
 * Exactly the bytes a device signs — the one definition both clients and the
 * server build from, because a disagreement here is an outage, not a bug
 * report.
 *
 * `origin` is the lowercased host (with port, when the URL carries one) of the
 * backend the client is talking to. Omitted, this produces the v1 message, so
 * a client that has not been updated keeps working unchanged.
 */
export function deviceProofMessage(challenge: string, origin?: string | null): string {
  // Length-prefixed, so the encoding is canonical whatever the host contains.
  // Joining with a bare colon was ambiguous — `host "a:1" + challenge "n"` and
  // `host "a" + challenge "1:n"` produced the same bytes, which is a signature
  // that means two things. Unreachable in practice (a challenge is base64url
  // and a host comes from a fixed allow-list), but "unreachable in practice"
  // is how protocol bugs are written, and the fix costs one number.
  return origin
    ? `${DEVICE_AUTH_PREFIX_V2}${origin.length}:${origin}:${challenge}`
    : `${DEVICE_AUTH_PREFIX}${challenge}`;
}

/**
 * The host to sign, from a base URL. `null` when the input is not a URL with a
 * host — the caller then sends no `proofOrigin` and stays on v1 rather than
 * signing something meaningless.
 *
 * Lowercased because DNS is case-insensitive and the two sides must agree
 * byte-for-byte; the port is kept because `:8080` and `:443` are different
 * servers.
 */
export function proofOriginOf(apiBaseUrl: string): string | null {
  try {
    const { host } = new URL(apiBaseUrl);
    return host ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A server-issued, single-use, short-lived nonce. */
export const DeviceChallengeSchema = z.object({
  /** base64url; the exact string to append to `DEVICE_AUTH_PREFIX`. */
  challenge: z.string().min(16).max(128),
  expiresInSeconds: z.number().int().positive(),
});
export type DeviceChallenge = z.infer<typeof DeviceChallengeSchema>;

/**
 * The fields every proof-of-possession carries.
 *
 * `appVersion` is not part of the proof and is deliberately optional: it is
 * bookkeeping, and a client that omits it must still be able to sign in. It
 * rides along here because `/devices/token` is the one request every client
 * makes on every launch and every ten minutes thereafter, which makes it the
 * only place a version can be kept current without inventing a heartbeat.
 * Free-form rather than semver-validated — an older client's format is not
 * something a newer server gets to reject, and the value is only ever read by
 * a person.
 */
const proofFields = {
  challenge: z.string().min(16).max(128),
  publicKey: PublicKeySchema,
  signature: SignatureSchema,
  appVersion: z.string().min(1).max(40).nullish(),
  /**
   * What this machine currently calls itself.
   *
   * Rides along for the same reason `appVersion` does, and it is bookkeeping
   * in the same way: never part of the proof, never an authorization input,
   * and a client that omits it still signs in.
   *
   * It exists so a device that enrolled under a placeholder heals itself.
   * Every Mac used to enroll as the literal `"macos desktop"` and every phone
   * as `"ios phone"`, and an account with three of them listed three
   * indistinguishable rows. The server only applies this over a placeholder it
   * recognises, so a name the USER chose is never overwritten by the machine.
   */
  deviceName: z.string().min(1).max(120).nullish(),
  /**
   * The host this client believes it is talking to, and therefore the host it
   * signed ([`deviceProofMessage`](#)). Its PRESENCE selects v2 — there is no
   * separate version field, because "did you name a server?" is the only
   * question that matters.
   *
   * The server does not take this on trust: it checks the host is one of its
   * own before verifying anything, so an attacker cannot simply claim the
   * host they wish they had a signature for.
   */
  proofOrigin: z.string().min(1).max(255).nullish(),
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
   * historical trust rows still resolve.
   *
   * The SAME rule `/connect/request` applies, and it did not used to be. Three
   * routes take a wire device id and only `connect.ts` checked its shape, so a
   * device could enroll as `mac-abc123`, pair, appear on the account as linked
   * — and then be permanently unable to connect, because `/connect/request`
   * answered `400 invalid_request` to the id enrollment had just accepted.
   * Proved by `scripts/e2e-audit.mjs`, which was minting exactly that shape and
   * had four failing checks nobody could explain. A boundary that admits an
   * identifier the next boundary refuses is not a boundary. */
  fingerprint: WireDeviceIdSchema,
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
  /**
   * `devices.fingerprint` — the WIRE id this device is actually known by, which
   * is not always the one it just claimed.
   *
   * A client asserts its fingerprint, but the server resolves identity by
   * PUBLIC KEY, and the two can drift apart: on macOS the fingerprint is a file
   * in the app's data directory while the key is in the login keychain, so
   * clearing one and not the other gives a machine a new name for the same
   * identity. Every route that authorizes a device — `/pairing/create`,
   * `/connect/request`, the presence room — resolves by fingerprint, so a
   * client running under a name the server does not use is silently unable to
   * do anything, and re-enrolling answers `public_key_in_use` forever.
   *
   * Returning it makes the drift self-healing: the client adopts this value and
   * is itself again. Optional so a client can still read an older server's
   * response, which simply cannot tell it.
   */
  fingerprint: WireDeviceIdSchema.optional(),
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

/** What the desktop renders as a QR for the phone to scan.
 *
 * `apiBaseUrl` is the address the PHONE should use, which is not necessarily
 * the one the desktop was configured with — a laptop talking to
 * `http://localhost:8080` cannot put that in a QR. It comes from the same
 * `advertisedUrls()` seam `POST /pairing/create` uses, so a dev tunnel that
 * came up after boot is reflected here too. */
export const DesktopEnrollmentCodeSchema = z.object({
  code: z.string().min(16).max(128),
  expiresInSeconds: z.number().int().positive(),
  apiBaseUrl: z.string().url(),
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
  /** The newly linked desktop's `devices.id` — an internal uuid. Account-
   * scoped routes (`PATCH`/`DELETE /devices/:deviceId`) take this one. */
  deviceId: z.string().uuid(),
  /** The newly linked desktop's WIRE id (`devices.fingerprint`) — what the
   * phone must store and present to `/connect/request` and `/devices/unpair`.
   * Mirrors what `/pairing/redeem` returns under the same name, so both ways
   * of acquiring a laptop hand the phone the same kind of identifier.
   *
   * Optional on the wire so a phone running against an older backend still
   * parses the response; such a phone simply cannot remember the laptop. */
  desktopDeviceId: WireDeviceIdSchema.optional(),
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

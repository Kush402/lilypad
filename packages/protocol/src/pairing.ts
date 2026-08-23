import { z } from 'zod';

/**
 * REST contracts for the pairing handshake (Milestone 1).
 *
 *   desktop → POST /pairing/create → { token, roomId, ... , expiresInSeconds }
 *   mobile  → POST /pairing/redeem → burns token, returns room join info
 */

/** Which side of a pair a device sits on. */
export const DeviceKindSchema = z.enum(['desktop', 'mobile']);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

export const PlatformSchema = z.enum(['macos', 'windows', 'linux', 'ios', 'android']);
export type Platform = z.infer<typeof PlatformSchema>;

/** Permission scope requested/granted for a session. */
/**
 * A device's WIRE id — `devices.fingerprint`, the string clients put in a
 * request body. Never `devices.id`, which is an internal Postgres uuid.
 *
 * The two are both strings of similar length, and confusing them is not
 * hypothetical: `/devices/enrollment-code/approve` returned the uuid under a
 * field the phone stored as the wire id, so every later `/connect/request`
 * and `/devices/unpair` looked up a fingerprint that could not exist. The
 * backend answered `404 not_trusted` — "this laptop hasn't trusted this
 * phone" — about a pair that was live in the database, and the phone's
 * Forget reported success while severing nothing. Both clients have always
 * minted `desktop-<uuid>` / `mobile-<random>`, so requiring the kind prefix
 * costs nothing and turns that silent 404 into a 400 that names the mistake.
 */
export const WireDeviceIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(
    /^(desktop|mobile)-/,
    'must be a wire device id (desktop-… / mobile-…), not a devices.id uuid',
  );

export const SessionScopeSchema = z.enum(['view', 'control']);
export type SessionScope = z.infer<typeof SessionScopeSchema>;

// ── POST /pairing/create (called by the desktop) ─────────────────────────────
export const PairingCreateRequestSchema = z.object({
  /** This desktop's wire deviceId — `devices.fingerprint`. */
  deviceId: WireDeviceIdSchema,
  deviceName: z.string().min(1).max(120).optional(),
  platform: PlatformSchema.optional(),
  /** Scopes the desktop is willing to grant. Defaults to ['view','control']. */
  scopes: z.array(SessionScopeSchema).nonempty().optional(),
});
export type PairingCreateRequest = z.infer<typeof PairingCreateRequestSchema>;

export const PairingCreateResponseSchema = z.object({
  token: z.string(),
  roomId: z.string(),
  apiBaseUrl: z.string(),
  signalingUrl: z.string(),
  expiresInSeconds: z.number().int().positive(),
});
export type PairingCreateResponse = z.infer<typeof PairingCreateResponseSchema>;

// ── POST /pairing/redeem (called by the mobile app) ──────────────────────────
export const PairingRedeemRequestSchema = z.object({
  token: z.string().min(16),
  /** This phone's wire deviceId — `devices.fingerprint`. */
  deviceId: WireDeviceIdSchema,
  deviceName: z.string().min(1).max(120).optional(),
  platform: PlatformSchema.optional(),
});
export type PairingRedeemRequest = z.infer<typeof PairingRedeemRequestSchema>;

export const PairingRedeemResponseSchema = z.object({
  roomId: z.string(),
  signalingUrl: z.string(),
  /** Scopes the desktop offered; the phone joins signaling to request approval. */
  scopes: z.array(SessionScopeSchema),
  desktopDeviceName: z.string().nullable(),
  /** The desktop's wire deviceId (M5.4) — what the phone stores to ring this
   * desktop later via POST /connect/request. Optional so old backends stay
   * valid; a phone simply can't offer no-QR reconnect for pairs made
   * against one. */
  desktopDeviceId: z.string().optional(),
});
export type PairingRedeemResponse = z.infer<typeof PairingRedeemResponseSchema>;

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
export const SessionScopeSchema = z.enum(['view', 'control']);
export type SessionScope = z.infer<typeof SessionScopeSchema>;

// ── POST /pairing/create (called by the desktop) ─────────────────────────────
export const PairingCreateRequestSchema = z.object({
  /** Locally generated stable id for this desktop (dev mode; real auth in M5). */
  deviceId: z.string().min(8),
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
  /** Locally generated stable id for this phone. */
  deviceId: z.string().min(8),
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
});
export type PairingRedeemResponse = z.infer<typeof PairingRedeemResponseSchema>;

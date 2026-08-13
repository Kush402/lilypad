import { z } from 'zod';
import { SessionScopeSchema } from './pairing.js';

/**
 * REST contract for the M5.4 no-QR reconnect (`POST /connect/request`).
 *
 * A phone that holds a persistent trust relationship with a desktop asks the
 * backend to ring it: the backend verifies the pair, mints a fresh
 * room-auth-bound session room, delivers a `connect-request` over the
 * desktop's presence channel, and hands the phone the same join info a QR
 * redeem would — so the phone's session flow downstream is IDENTICAL to
 * pairing (`PairingRedeemResponse` shape, deliberately).
 */

export const ConnectRequestSchema = z.object({
  /** The trusted desktop's wire deviceId (devices.fingerprint). */
  desktopDeviceId: z.string().min(8).max(128),
  /** This phone's stable wire deviceId. */
  mobileDeviceId: z.string().min(8).max(128),
  mobileDeviceName: z.string().min(1).max(120).nullish(),
  /** The per-pair connect secret issued at trust time (M5.4 security).
   * Optional on the WIRE only, so an older client still parses; the server
   * refuses every pair without one, including the pre-secret rows that were
   * once admitted with no secret at all (SEC-5, migration `0005`). A phone
   * that lost its secret re-pairs once with a QR. */
  pairSecret: z.string().min(16).max(128).optional(),
});
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;

export const ConnectResponseSchema = z.object({
  roomId: z.string(),
  signalingUrl: z.string(),
  scopes: z.array(SessionScopeSchema),
  desktopDeviceName: z.string().nullable(),
});
export type ConnectResponse = z.infer<typeof ConnectResponseSchema>;

/** Machine-readable failure codes the connect endpoint returns. */
export type ConnectErrorCode = 'not_trusted' | 'revoked' | 'desktop_offline';

/** Mobile-initiated unpair (the symmetric counterpart to ConnectRequest):
 * a phone "Forgets" a laptop, severing the trust pairing on the backend so it
 * also disappears from the laptop's Trusted Devices. Keyed by the same two
 * wire device ids as a connect; no secret needed (revoking is strictly less
 * powerful than connecting, and self-directed). */
export const UnpairRequestSchema = z.object({
  desktopDeviceId: z.string().min(8).max(128),
  mobileDeviceId: z.string().min(8).max(128),
});
export type UnpairRequest = z.infer<typeof UnpairRequestSchema>;

// ── Trusted-pair management (desktop dashboard) ──────────────────────────────

/** One pair as GET /devices/pairs returns it. */
export const TrustedPairListingSchema = z.object({
  pairId: z.string().uuid(),
  mobileFingerprint: z.string(),
  displayName: z.string().nullable(),
  autoApprove: z.boolean(),
  revoked: z.boolean(),
  lastConnectedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TrustedPairListing = z.infer<typeof TrustedPairListingSchema>;

export const DevicePairsQuerySchema = z.object({
  desktopDeviceId: z.string().min(8).max(128),
});

export const PairIdParamsSchema = z.object({
  pairId: z.string().uuid(),
});

export const PairAutoApprovePatchSchema = z.object({
  autoApprove: z.boolean(),
});

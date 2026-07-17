import { z } from 'zod';
import { QR_PAYLOAD_VERSION } from './constants.js';
import { PlatformSchema } from './pairing.js';

/**
 * The exact JSON encoded into the QR code shown on the desktop.
 *
 * It intentionally carries NO secrets beyond the opaque single-use `token`:
 * the token is meaningless without the backend (which holds the 60s Redis
 * entry binding it to a desktop device + room).
 */
export const QrPayloadSchema = z.object({
  /** QR schema version — lets the scanner reject incompatible desktops. */
  v: z.literal(QR_PAYLOAD_VERSION),
  /** Opaque single-use pairing token (redeemed via POST /pairing/redeem). */
  token: z.string().min(16),
  /** Signaling room id both peers will join after approval. */
  roomId: z.string().min(1),
  /** Base URL of the backend REST API (for /pairing/redeem). */
  apiBaseUrl: z.string().url(),
  /** WebSocket signaling URL (used from M2 onward). */
  signalingUrl: z.string().url().or(z.string().startsWith('ws')),
  /** Human-readable desktop name, shown at the pairing-confirmation moment
   * so a user has an actual identity signal to check before redeeming a
   * single-use token — see `docs/audit/m3/mobile-ux.md` Finding 9. Optional
   * so a scanner never hard-rejects a payload missing it. */
  deviceName: z.string().max(120).nullable().optional(),
  platform: PlatformSchema.optional(),
});

export type QrPayload = z.infer<typeof QrPayloadSchema>;

/** Serialize a payload to the compact string embedded in the QR image. */
export function encodeQrPayload(payload: QrPayload): string {
  return JSON.stringify(QrPayloadSchema.parse(payload));
}

/** Parse + validate a scanned QR string. Throws if malformed/incompatible. */
export function decodeQrPayload(raw: string): QrPayload {
  return QrPayloadSchema.parse(JSON.parse(raw));
}

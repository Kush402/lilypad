import { z } from 'zod';
import { QR_PAYLOAD_VERSION } from './constants.js';
import { PlatformSchema } from './pairing.js';
import { DesktopEnrollmentQrSchema, type DesktopEnrollmentQr } from './identity.js';

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

/**
 * A scanned Lilypad code, of either kind.
 *
 * The phone's camera is one surface and there are two codes a laptop can show:
 * **pair** ("let this phone control this laptop now") and **link** ("add this
 * computer to my account", [ADR-0008](../../../docs/adr/0008-desktop-enrollment-via-phone.md)).
 * They are genuinely different acts — the second is the higher-privilege one —
 * so the scanner must be able to tell them apart and say which is about to
 * happen, rather than guessing from context.
 */
export type ScannedCode =
  { kind: 'pair'; payload: QrPayload } | { kind: 'link'; payload: DesktopEnrollmentQr };

/**
 * Classify a scanned string. Throws for anything that is not a Lilypad code —
 * the caller's honest answer is the same either way ("that isn't a Lilypad
 * code"), and telling a scanner WHICH schema it failed would only help someone
 * probing what the app accepts.
 */
export function decodeScannedCode(raw: string): ScannedCode {
  const json: unknown = JSON.parse(raw);
  const link = DesktopEnrollmentQrSchema.safeParse(json);
  if (link.success) return { kind: 'link', payload: link.data };
  return { kind: 'pair', payload: QrPayloadSchema.parse(json) };
}

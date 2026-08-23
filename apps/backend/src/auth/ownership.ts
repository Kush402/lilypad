import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, trustedDevices, users } from '../db/schema.js';
import { deviceState } from './deviceState.js';
import type { DeviceState } from '@lilypad/protocol';

/**
 * Who owns what — the single place a route asks "may this actor touch this
 * resource?" ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
 *
 * The rule the whole product rests on: **every resource is owned by exactly
 * one account, and access requires the token's subject to be that owner.**
 * Never a value from the request body, a query string, or a path parameter —
 * those are what the caller claims, and before this existed, claiming was
 * enough: `GET /devices/pairs?desktopDeviceId=…` listed any laptop's phones
 * and `DELETE /devices/pairs/:pairId` revoked any pair and killed its live
 * session, by uuid alone.
 *
 * These helpers deliberately answer with a null/boolean rather than throwing.
 * A caller that cannot distinguish "not yours" from "does not exist" is a
 * caller that cannot leak the difference, and both must answer 404.
 */

/**
 * Whether the account a token names still exists.
 *
 * Its own function rather than a join onto the device lookup because it is
 * needed exactly where there is no device to join to: an ACCOUNT-scoped token,
 * on the routes that accept one. A device-scoped token needs no separate check
 * — `devices.user_id` is a foreign key, so a device row that still exists
 * proves its owner does.
 */
export async function accountExists(userId: string, database = db): Promise<boolean> {
  const rows = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows.length > 0;
}

export interface DeviceOwnership {
  deviceId: string;
  userId: string | null;
  state: DeviceState;
}

/**
 * Who an audit row for a SESSION should name.
 *
 * `audit_logs` has one `user_id` and one `device_id`, and a session has two
 * devices, so this picks. Both fingerprints stay in `metadata`, so nothing is
 * lost by choosing.
 *
 * - **`deviceId` is the phone.** It is the actor — the thing that reached out
 *   and connected. The question a user asks of an audit log is "what connected
 *   to my Mac", and the Mac is the constant in that sentence.
 * - **`userId` falls back to the desktop's owner.** A session that reaches an
 *   owned Mac belongs to that Mac's owner even when the phone is unowned,
 *   which `authorize.ts`'s unowned lane still permits. Reporting null there
 *   would hide the session from the one person entitled to see it.
 *
 * Both `session_start` and `session_end` rows were written with neither field
 * before this existed: 21 of 21 rows in production carried `user_id IS NULL`
 * and `device_id IS NULL` on 2026-08-21, which made "who connected to my Mac"
 * unanswerable from the audit log of a product sold on being auditable.
 */
export function attributeSession(
  desktop: DeviceOwnership | null,
  mobile: DeviceOwnership | null,
): { userId: string | null; deviceId: string | null } {
  return {
    userId: mobile?.userId ?? desktop?.userId ?? null,
    deviceId: mobile?.deviceId ?? null,
  };
}

/** Resolve a device by its WIRE id (`devices.fingerprint`) — what clients
 * send — to its owner and lifecycle state. */
export async function deviceOwnershipByFingerprint(
  kind: 'desktop' | 'mobile',
  fingerprint: string,
  database = db,
): Promise<DeviceOwnership | null> {
  const rows = await database
    .select({
      id: devices.id,
      userId: devices.userId,
      publicKey: devices.publicKey,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(and(eq(devices.kind, kind), eq(devices.fingerprint, fingerprint)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { deviceId: row.id, userId: row.userId, state: deviceState(row) };
}

/** Resolve a device by its `devices.id` uuid. */
export async function deviceOwnershipById(
  deviceId: string,
  database = db,
): Promise<DeviceOwnership | null> {
  const rows = await database
    .select({
      id: devices.id,
      userId: devices.userId,
      publicKey: devices.publicKey,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { deviceId: row.id, userId: row.userId, state: deviceState(row) };
}

/** Both sides of a pair, with their owners. */
export interface PairOwnership {
  pairId: string;
  desktop: DeviceOwnership;
  mobile: DeviceOwnership;
}

export async function pairOwnership(pairId: string, database = db): Promise<PairOwnership | null> {
  const rows = await database
    .select({
      pairId: trustedDevices.id,
      desktopDeviceId: trustedDevices.desktopDeviceId,
      mobileDeviceId: trustedDevices.mobileDeviceId,
    })
    .from(trustedDevices)
    .where(eq(trustedDevices.id, pairId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const [desktop, mobile] = await Promise.all([
    deviceOwnershipById(row.desktopDeviceId, database),
    deviceOwnershipById(row.mobileDeviceId, database),
  ]);
  if (!desktop || !mobile) return null;
  return { pairId: row.pairId, desktop, mobile };
}

/**
 * Whether `userId` owns this device.
 *
 * An unowned device (`user_id IS NULL`, a pre-accounts row that never
 * enrolled) belongs to NOBODY — it deliberately does not belong to whoever
 * asks. Enrolling claims such a row; asking about it never does.
 */
export function ownsDevice(actorUserId: string, device: DeviceOwnership): boolean {
  return device.userId !== null && device.userId === actorUserId;
}

/**
 * Whether `userId` may manage this pair.
 *
 * Either side is sufficient, and that is intentional: a pair is a relationship
 * between two devices, and both the laptop's owner ("stop trusting this
 * phone") and the phone's owner ("forget this laptop") must be able to sever
 * it. Today those are the same person; cross-account sharing later is exactly
 * the case where they are not, and either party ending it is still correct.
 */
export function canManagePair(actorUserId: string, pair: PairOwnership): boolean {
  return ownsDevice(actorUserId, pair.desktop) || ownsDevice(actorUserId, pair.mobile);
}

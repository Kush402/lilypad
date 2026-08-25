import { and, eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { devices } from '../db/schema.js';
import { deviceState } from '../auth/deviceState.js';
import type { AccountDevice, DeviceKind, Platform } from '@lilypad/protocol';

/**
 * The account's own devices (P2) — list, rename, revoke.
 *
 * Distinct from `trust.ts`, which manages PAIRS (which phone may reach which
 * laptop). This manages OWNERSHIP (which machines are yours), and revoking
 * here is strictly stronger: a revoked device cannot authenticate at all, so it
 * loses every pairing at once rather than one.
 */

/** One device row as the service reads it, before presentation. */
export interface AccountDeviceRow {
  id: string;
  kind: DeviceKind;
  platform: Platform | null;
  name: string | null;
  fingerprint: string;
  userId: string | null;
  publicKey: string | null;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  appVersion: string | null;
  createdAt: Date;
}

export interface AccountDeviceStore {
  listForUser(userId: string): Promise<AccountDeviceRow[]>;
  rename(deviceId: string, name: string): Promise<void>;
  /** Withdraw ownership. Sets `revoked_at`; the row survives as audit trail,
   * exactly as pair revocation does. */
  revoke(deviceId: string, at: Date): Promise<void>;
  /** The wire fingerprint of a device, for finding its live rooms — the hub is
   * keyed by fingerprint, not by these uuids. */
  fingerprintOf(deviceId: string): Promise<string | null>;
}

/** Show only a short suffix of a fingerprint, the same treatment
 * `trust.listPairsForDesktop` gives one. A full fingerprint is an input to the
 * pairing surface; a listing has no reason to hand one out. */
export function maskFingerprint(fp: string): string {
  return fp.length <= 6 ? fp : `…${fp.slice(-6)}`;
}

/**
 * Present a row for the wire.
 *
 * `activeSession` comes from the caller (the signaling hub), not the database:
 * the `sessions` table is still never written, and rendering an empty table as
 * "no active sessions" would state something false rather than omit something
 * missing.
 */
export function toAccountDevice(
  row: AccountDeviceRow,
  opts: { activeSession: boolean; isCurrentDevice: boolean },
): AccountDevice {
  return {
    id: row.id,
    kind: row.kind,
    platform: row.platform,
    name: row.name,
    fingerprint: maskFingerprint(row.fingerprint),
    state: deviceState(row),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    appVersion: row.appVersion,
    createdAt: row.createdAt.toISOString(),
    activeSession: opts.activeSession,
    isCurrentDevice: opts.isCurrentDevice,
  };
}

/**
 * The order "Your devices" is read in.
 *
 * The query had none, so Postgres returned whatever the heap gave it and the
 * phone rendered it verbatim: a screenshot on 2026-08-24 showed 2m, 1m, 3d,
 * 33h, 7h down the screen. Sorting on the client would fix one client; sorting
 * here fixes every reader of the endpoint, and the two facts the top of the
 * list turns on — which device is asking, and which are in a session — are
 * known here and nowhere else.
 *
 * Revoked rows sink to the bottom whatever else is true of them: they are
 * history, and history that outranks a live device is a list that misleads at
 * a glance.
 */
export function orderDevices(devices: AccountDevice[]): AccountDevice[] {
  const rank = (d: AccountDevice): number[] => [
    d.state === 'revoked' ? 1 : 0,
    d.isCurrentDevice ? 0 : 1,
    d.activeSession ? 0 : 1,
    // Negated so a later timestamp sorts first; never-seen sorts last.
    d.lastSeenAt ? -Date.parse(d.lastSeenAt) : Number.POSITIVE_INFINITY,
  ];
  return [...devices].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i += 1) {
      if (x[i] !== y[i]) return x[i] - y[i];
    }
    // Newest first among rows that tie on everything above, so the order is
    // stable rather than left to the database.
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

export class AccountDeviceService {
  constructor(private readonly store: AccountDeviceStore) {}

  /**
   * Every device on this account.
   *
   * `isLive` is asked per device rather than per pair, because ownership is
   * per device: a laptop in a session with any phone is busy, and so is that
   * phone.
   */
  async list(
    userId: string,
    currentDeviceId: string | null,
    isLive: (kind: DeviceKind, fingerprint: string) => boolean,
  ): Promise<AccountDevice[]> {
    const rows = await this.store.listForUser(userId);
    return orderDevices(
      rows.map((row) =>
        toAccountDevice(row, {
          activeSession: isLive(row.kind, row.fingerprint),
          isCurrentDevice: row.id === currentDeviceId,
        }),
      ),
    );
  }

  async rename(deviceId: string, name: string): Promise<void> {
    await this.store.rename(deviceId, name);
  }

  /**
   * Withdraw ownership, and return the device's wire fingerprint so the caller
   * can force-end its live sessions.
   *
   * Ending them is not optional. An access token lives for ten minutes, so a
   * revoke that only wrote a column would leave a stolen laptop controllable
   * for ten more minutes — the exact window "revoke" exists to close. Pair
   * revocation already works this way (`endRoomsForDevicePair`).
   */
  async revoke(deviceId: string, now: Date = new Date()): Promise<{ fingerprint: string } | null> {
    const fingerprint = await this.store.fingerprintOf(deviceId);
    if (fingerprint === null) return null;
    await this.store.revoke(deviceId, now);
    return { fingerprint };
  }
}

/** Adapts the real Drizzle client. */
export function createDrizzleAccountDeviceStore(
  database: typeof defaultDb = defaultDb,
): AccountDeviceStore {
  return {
    async listForUser(userId) {
      return database
        .select({
          id: devices.id,
          kind: devices.kind,
          platform: devices.platform,
          name: devices.name,
          fingerprint: devices.fingerprint,
          userId: devices.userId,
          publicKey: devices.publicKey,
          revokedAt: devices.revokedAt,
          lastSeenAt: devices.lastSeenAt,
          appVersion: devices.appVersion,
          createdAt: devices.createdAt,
        })
        .from(devices)
        .where(eq(devices.userId, userId));
    },
    async rename(deviceId, name) {
      await database.update(devices).set({ name }).where(eq(devices.id, deviceId));
    },
    async revoke(deviceId, at) {
      // Guarded on still being unrevoked so a second revoke does not move the
      // timestamp — the first one is when access actually ended.
      await database
        .update(devices)
        .set({ revokedAt: at })
        .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)));
    },
    async fingerprintOf(deviceId) {
      const rows = await database
        .select({ fingerprint: devices.fingerprint })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      return rows[0]?.fingerprint ?? null;
    },
  };
}

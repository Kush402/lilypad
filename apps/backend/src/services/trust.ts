import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { devices, trustedDevices } from '../db/schema.js';
import type { DeviceKind } from '@lilypad/protocol';

/**
 * Persistent desktop↔mobile pair trust (M5.4) — the durable record behind
 * "pair once, reconnect without a QR." Rows are created when a desktop
 * approval carries `trust: true` (the "Trust this device" checkbox), read by
 * `POST /connect/request`, and severed by Forget/Revoke (which SETS
 * `revokedAt` rather than deleting — the row is the audit trail).
 *
 * Identity note (pre-M5-keys): devices are keyed by their wire `deviceId`
 * string, stored as `devices.fingerprint` — the same self-asserted identity
 * the rest of the system runs on today. The M5 device-identity milestone
 * upgrades what's PROVEN about these strings (Ed25519 challenge-response
 * filling `devices.publicKey`); this service's shape doesn't change.
 */

/** One trust row, as the service exposes it. */
export interface TrustedPair {
  pairId: string;
  desktopDeviceId: string; // devices.id (uuid)
  mobileDeviceId: string; // devices.id (uuid)
  autoApprove: boolean;
  revoked: boolean;
  displayName: string | null;
}

/** A pair as the desktop's Trusted Devices dashboard sees it — joined with
 * the mobile device row so the UI can show WHICH phone. */
export interface PairListing {
  pairId: string;
  mobileFingerprint: string;
  displayName: string | null;
  autoApprove: boolean;
  revoked: boolean;
  lastConnectedAt: string | null; // ISO, for the wire
  createdAt: string;
}

/** Minimal DB surface — satisfied by the real Drizzle adapter below and by
 * an in-memory fake in tests (the `AuditLogStore`/`KvStore` pattern). */
export interface TrustStore {
  /** Find a device row id by (kind, fingerprint); create it if missing. */
  upsertDevice(kind: DeviceKind, fingerprint: string): Promise<string>;
  /** The pair row for two device UUIDs, if one exists. */
  getPairByDeviceIds(desktopId: string, mobileId: string): Promise<TrustedPair | null>;
  insertPair(desktopId: string, mobileId: string, autoApprove: boolean): Promise<TrustedPair>;
  /** Every pair for one desktop, joined with each mobile device row. */
  listPairsForDesktop(desktopId: string): Promise<PairListing[]>;
  /** Patch mutable pair fields. Absent fields are left untouched. */
  updatePair(
    pairId: string,
    patch: { revoked?: boolean; autoApprove?: boolean; lastConnectedAt?: Date },
  ): Promise<void>;
  /** Device row (uuid + fingerprint) by fingerprint, if registered. */
  getDeviceByFingerprint(kind: DeviceKind, fingerprint: string): Promise<{ id: string } | null>;
}

export class TrustService {
  constructor(private readonly store: TrustStore) {}

  /**
   * Record (or re-affirm) trust between two devices, by their wire ids.
   * Re-trusting a previously revoked pair un-revokes it — the user just
   * re-ran the full QR + approve ceremony, which is exactly the bar that
   * established trust the first time. Idempotent for an active pair.
   *
   * New pairs default to `autoApprove: true`: the explicit trust ceremony IS
   * the consent moment — a trusted phone reconnecting like a Bluetooth
   * device is the whole product promise, and requiring a desktop-side tap on
   * every reconnect would make "trusted" meaningless. The visible session
   * indicator, audit log, panic disconnect, and the per-pair dashboard
   * toggle (require approval / revoke) keep this inside the threat model's
   * "no silent access" line. An EXISTING pair's setting is never overridden
   * here — the user may have deliberately turned approval back on.
   */
  async establishTrust(desktopFingerprint: string, mobileFingerprint: string): Promise<void> {
    const desktopId = await this.store.upsertDevice('desktop', desktopFingerprint);
    const mobileId = await this.store.upsertDevice('mobile', mobileFingerprint);
    const existing = await this.store.getPairByDeviceIds(desktopId, mobileId);
    if (!existing) {
      await this.store.insertPair(desktopId, mobileId, true);
      return;
    }
    if (existing.revoked) {
      await this.store.updatePair(existing.pairId, { revoked: false });
    }
  }

  /** Every pair for a desktop (by wire id) — the Trusted Devices dashboard. */
  async listForDesktop(desktopFingerprint: string): Promise<PairListing[]> {
    const desktop = await this.store.getDeviceByFingerprint('desktop', desktopFingerprint);
    if (!desktop) return [];
    return this.store.listPairsForDesktop(desktop.id);
  }

  /** Flip a pair's "connect without approval" setting. */
  async setAutoApprove(pairId: string, enabled: boolean): Promise<void> {
    await this.store.updatePair(pairId, { autoApprove: enabled });
  }

  /** The ACTIVE (non-revoked) pair for two wire ids, or null. `null` covers
   * never-trusted, unknown devices, and revoked alike — the connect gate
   * fails closed on all three; the caller can distinguish revoked for a
   * clearer client message via `revoked` on the returned row. */
  async findPair(
    desktopFingerprint: string,
    mobileFingerprint: string,
  ): Promise<TrustedPair | null> {
    const desktop = await this.store.getDeviceByFingerprint('desktop', desktopFingerprint);
    const mobile = await this.store.getDeviceByFingerprint('mobile', mobileFingerprint);
    if (!desktop || !mobile) return null;
    return this.store.getPairByDeviceIds(desktop.id, mobile.id);
  }

  /** Mark a successful no-QR connect (updates `lastConnectedAt`). */
  async touchConnected(pairId: string): Promise<void> {
    await this.store.updatePair(pairId, { lastConnectedAt: new Date() });
  }

  /** Sever the pair (Forget on the phone / Revoke on the desktop). The row
   * stays for the audit trail; the connect gate fails closed from now on. */
  async revoke(pairId: string): Promise<void> {
    await this.store.updatePair(pairId, { revoked: true });
  }
}

/** Adapts the real Drizzle client to `TrustStore`. */
export function createDrizzleTrustStore(database: typeof defaultDb = defaultDb): TrustStore {
  const toPair = (row: typeof trustedDevices.$inferSelect): TrustedPair => ({
    pairId: row.id,
    desktopDeviceId: row.desktopDeviceId,
    mobileDeviceId: row.mobileDeviceId,
    autoApprove: row.autoApprove,
    revoked: row.revokedAt !== null,
    displayName: row.displayName,
  });
  return {
    async upsertDevice(kind, fingerprint) {
      const found = await database
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.kind, kind), eq(devices.fingerprint, fingerprint)))
        .limit(1);
      if (found[0]) return found[0].id;
      const inserted = await database
        .insert(devices)
        .values({ kind, fingerprint })
        .returning({ id: devices.id });
      const row = inserted[0];
      if (!row) throw new Error('device insert returned no row');
      return row.id;
    },
    async getPairByDeviceIds(desktopId, mobileId) {
      const rows = await database
        .select()
        .from(trustedDevices)
        .where(
          and(
            eq(trustedDevices.desktopDeviceId, desktopId),
            eq(trustedDevices.mobileDeviceId, mobileId),
          ),
        )
        .limit(1);
      return rows[0] ? toPair(rows[0]) : null;
    },
    async insertPair(desktopId, mobileId, autoApprove) {
      const inserted = await database
        .insert(trustedDevices)
        .values({ desktopDeviceId: desktopId, mobileDeviceId: mobileId, autoApprove })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('trusted_devices insert returned no row');
      return toPair(row);
    },
    async listPairsForDesktop(desktopId) {
      const rows = await database
        .select({
          pairId: trustedDevices.id,
          mobileFingerprint: devices.fingerprint,
          displayName: trustedDevices.displayName,
          autoApprove: trustedDevices.autoApprove,
          revokedAt: trustedDevices.revokedAt,
          lastConnectedAt: trustedDevices.lastConnectedAt,
          createdAt: trustedDevices.createdAt,
        })
        .from(trustedDevices)
        .innerJoin(devices, eq(trustedDevices.mobileDeviceId, devices.id))
        .where(eq(trustedDevices.desktopDeviceId, desktopId));
      return rows.map((r) => ({
        pairId: r.pairId,
        mobileFingerprint: r.mobileFingerprint,
        displayName: r.displayName,
        autoApprove: r.autoApprove,
        revoked: r.revokedAt !== null,
        lastConnectedAt: r.lastConnectedAt ? r.lastConnectedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      }));
    },
    async updatePair(pairId, patch) {
      const set: Partial<typeof trustedDevices.$inferInsert> = {};
      if (patch.revoked !== undefined) set.revokedAt = patch.revoked ? new Date() : null;
      if (patch.autoApprove !== undefined) set.autoApprove = patch.autoApprove;
      if (patch.lastConnectedAt !== undefined) set.lastConnectedAt = patch.lastConnectedAt;
      await database.update(trustedDevices).set(set).where(eq(trustedDevices.id, pairId));
    },
    async getDeviceByFingerprint(kind, fingerprint) {
      const rows = await database
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.kind, kind), eq(devices.fingerprint, fingerprint)))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

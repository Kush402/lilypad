import { and, eq } from 'drizzle-orm';
import type { DeviceKind } from '@lilypad/protocol';
import { db as defaultDb } from '../db/client.js';
import { devices } from '../db/schema.js';

/**
 * Binding a proven keypair to an account
 * ([ADR-0002](../../../../docs/adr/0002-device-identity.md)).
 *
 * The rules here decide who owns a machine, so they are stated rather than
 * implied:
 *
 * 1. **A public key names one device.** If a key is already on another row,
 *    enrollment is refused. Two devices sharing a key would make the key
 *    useless as an identity.
 * 2. **An owned device cannot be re-claimed by a different account.** Someone
 *    who learns a laptop's fingerprint must not be able to enroll it onto their
 *    own account and inherit it.
 * 3. **An unowned row IS claimable.** Rows created before accounts existed have
 *    `user_id = NULL`; the first account to enroll that fingerprint adopts it,
 *    which is the backfill path the schema was built for — existing trust
 *    relationships survive the introduction of accounts instead of being
 *    orphaned.
 */

export type EnrollFailure = 'public_key_in_use' | 'device_owned_by_another_account';

export type EnrollResult = { ok: true; deviceId: string } | { ok: false; reason: EnrollFailure };

export interface DeviceRow {
  id: string;
  userId: string | null;
  kind: DeviceKind;
  fingerprint: string;
  revokedAt: Date | null;
}

export interface DeviceIdentityStore {
  findByPublicKey(publicKey: string): Promise<DeviceRow | null>;
  findByFingerprint(kind: DeviceKind, fingerprint: string): Promise<DeviceRow | null>;
  create(row: {
    userId: string;
    kind: DeviceKind;
    fingerprint: string;
    publicKey: string;
    name: string | null;
    platform: DevicePlatform | null;
  }): Promise<string>;
  /** Attach an owner and a key to an existing row, clearing any revocation —
   * re-enrolling a device is how a user un-revokes it deliberately. */
  claim(
    id: string,
    patch: {
      userId: string;
      publicKey: string;
      name: string | null;
      platform: DevicePlatform | null;
    },
  ): Promise<void>;
  touchLastSeen(id: string): Promise<void>;
}

export type DevicePlatform = 'macos' | 'windows' | 'linux' | 'ios' | 'android';

export interface EnrollInput {
  userId: string;
  kind: DeviceKind;
  fingerprint: string;
  publicKey: string;
  name?: string | null;
  platform?: DevicePlatform | null;
}

export type DeviceAuthFailure = 'device_not_enrolled' | 'device_revoked';

export type DeviceAuthResult =
  { ok: true; deviceId: string; userId: string } | { ok: false; reason: DeviceAuthFailure };

export class DeviceRegistry {
  constructor(private readonly store: DeviceIdentityStore) {}

  /** Bind a verified keypair to an account. Idempotent for the same device and
   * the same owner, so a client that re-enrolls after a reinstall succeeds. */
  async enroll(input: EnrollInput): Promise<EnrollResult> {
    const byKey = await this.store.findByPublicKey(input.publicKey);
    const byFingerprint = await this.store.findByFingerprint(input.kind, input.fingerprint);

    if (byKey && byKey.id !== byFingerprint?.id) {
      return { ok: false, reason: 'public_key_in_use' };
    }
    if (byFingerprint && byFingerprint.userId !== null && byFingerprint.userId !== input.userId) {
      return { ok: false, reason: 'device_owned_by_another_account' };
    }

    const patch = {
      userId: input.userId,
      publicKey: input.publicKey,
      name: input.name ?? null,
      platform: input.platform ?? null,
    };
    if (byFingerprint) {
      await this.store.claim(byFingerprint.id, patch);
      return { ok: true, deviceId: byFingerprint.id };
    }
    const id = await this.store.create({
      ...patch,
      kind: input.kind,
      fingerprint: input.fingerprint,
    });
    return { ok: true, deviceId: id };
  }

  /**
   * Resolve the account behind a proven key. The caller has already verified
   * the signature; this decides whether that key is still allowed to act.
   *
   * A row with no owner reports `device_not_enrolled` rather than a distinct
   * code: from the client's side "you were never enrolled" and "your enrollment
   * is incomplete" have the same remedy, and both are fixed by enrolling.
   */
  async authenticate(publicKey: string): Promise<DeviceAuthResult> {
    const row = await this.store.findByPublicKey(publicKey);
    if (!row || row.userId === null) return { ok: false, reason: 'device_not_enrolled' };
    if (row.revokedAt !== null) return { ok: false, reason: 'device_revoked' };
    await this.store.touchLastSeen(row.id);
    return { ok: true, deviceId: row.id, userId: row.userId };
  }
}

/** Adapts the real Drizzle client to `DeviceIdentityStore`. */
export function createDrizzleDeviceIdentityStore(
  database: typeof defaultDb = defaultDb,
): DeviceIdentityStore {
  const columns = {
    id: devices.id,
    userId: devices.userId,
    kind: devices.kind,
    fingerprint: devices.fingerprint,
    revokedAt: devices.revokedAt,
  };
  return {
    async findByPublicKey(publicKey) {
      const rows = await database
        .select(columns)
        .from(devices)
        .where(eq(devices.publicKey, publicKey))
        .limit(1);
      return rows[0] ?? null;
    },
    async findByFingerprint(kind, fingerprint) {
      const rows = await database
        .select(columns)
        .from(devices)
        .where(and(eq(devices.kind, kind), eq(devices.fingerprint, fingerprint)))
        .limit(1);
      return rows[0] ?? null;
    },
    async create(row) {
      const inserted = await database.insert(devices).values(row).returning({ id: devices.id });
      const created = inserted[0];
      if (!created) throw new Error('device insert returned no row');
      return created.id;
    },
    async claim(id, patch) {
      // A re-enrolling client need not resend its label. Writing the null
      // through would silently erase a name the user chose, so absent fields
      // are left alone rather than overwritten.
      await database
        .update(devices)
        .set({
          userId: patch.userId,
          publicKey: patch.publicKey,
          revokedAt: null,
          lastSeenAt: new Date(),
          ...(patch.name === null ? {} : { name: patch.name }),
          ...(patch.platform === null ? {} : { platform: patch.platform }),
        })
        .where(eq(devices.id, id));
    },
    async touchLastSeen(id) {
      await database.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, id));
    },
  };
}

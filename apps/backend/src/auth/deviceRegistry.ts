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

export type EnrollFailure =
  'public_key_in_use' | 'device_owned_by_another_account' | 'device_revoked';

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
  /** Insert a new device row. Returns `null` — rather than raising — when a
   * concurrent request already created a row with this (kind, fingerprint) or
   * this public key; the unique indexes are what make that outcome possible,
   * and `enroll` resolves against the row that won. */
  create(row: {
    userId: string;
    kind: DeviceKind;
    fingerprint: string;
    publicKey: string;
    name: string | null;
    platform: DevicePlatform | null;
  }): Promise<string | null>;
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
  /**
   * When the credential authorising this enrollment was minted.
   *
   * Present only for the self-enrollment path, where the caller proves nothing
   * but an account session. Enrolling clears `revoked_at`, so without this a
   * device revoked sixty seconds ago could re-enroll itself with the access
   * token it was already holding and be permanently back — the ten-minute
   * token lag turning into an undone revocation.
   *
   * Absent for the approval path, and deliberately so: a desktop is restored by
   * a DIFFERENT device approving its enrollment code, and that second device is
   * the proof. Demanding freshness there would break the recovery it exists for
   * without adding anything, since an attacker who holds the owner's phone has
   * already won.
   */
  credentialIssuedAt?: Date | null;
}

export type DeviceAuthFailure = 'device_not_enrolled' | 'device_revoked';

export type DeviceAuthResult =
  { ok: true; deviceId: string; userId: string } | { ok: false; reason: DeviceAuthFailure };

export class DeviceRegistry {
  constructor(private readonly store: DeviceIdentityStore) {}

  /**
   * Bind a verified keypair to an account. Idempotent for the same device and
   * the same owner, so a client that re-enrolls after a reinstall succeeds.
   *
   * Looking a device up and then inserting it is a check-then-act, and the
   * unique indexes on `devices` are what keep it honest — a concurrent
   * enrollment (a phone that timed out and was retried by hand is the ordinary
   * way in) can create the row in between. When that happens the insert
   * conflicts, and the answer is to resolve again against the row that won: the
   * second pass finds it and applies the same ownership rules, which is how
   * two racers converge on one device instead of one of them getting a 500.
   */
  async enroll(input: EnrollInput): Promise<EnrollResult> {
    const first = await this.attempt(input);
    if (first) return first;
    const second = await this.attempt(input);
    if (second) return second;
    // Unreachable: a conflict means a row exists, and the pass above looks for
    // it by both of the columns that could have conflicted. Raising beats
    // looping — the same reasoning as `TrustStore.upsertDevice`.
    throw new Error('device insert conflicted but no row exists');
  }

  /** One resolve-then-write pass. `null` means the write lost a race and the
   * caller should resolve again. */
  private async attempt(input: EnrollInput): Promise<EnrollResult | null> {
    const byKey = await this.store.findByPublicKey(input.publicKey);
    const byFingerprint = await this.store.findByFingerprint(input.kind, input.fingerprint);

    if (byKey && byKey.id !== byFingerprint?.id) {
      return { ok: false, reason: 'public_key_in_use' };
    }
    if (byFingerprint && byFingerprint.userId !== null && byFingerprint.userId !== input.userId) {
      return { ok: false, reason: 'device_owned_by_another_account' };
    }
    // A revoked device may only come back on a credential minted AFTER it was
    // revoked. `<=` rather than `<`: `iat` has one-second resolution, so a token
    // stamped in the same second as the revocation is not provably later, and
    // the tie goes to the person who pressed the button.
    if (
      byFingerprint?.revokedAt != null &&
      input.credentialIssuedAt != null &&
      input.credentialIssuedAt.getTime() <= byFingerprint.revokedAt.getTime()
    ) {
      return { ok: false, reason: 'device_revoked' };
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
    return id === null ? null : { ok: true, deviceId: id };
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
      // Conflict-tolerant on BOTH unique indexes: a concurrent enrollment may
      // have taken this (kind, fingerprint) or this public key since the
      // lookups above. No row back means the race was lost, which `enroll`
      // handles by resolving again — not an error.
      const inserted = await database
        .insert(devices)
        .values(row)
        .onConflictDoNothing()
        .returning({ id: devices.id });
      return inserted[0]?.id ?? null;
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

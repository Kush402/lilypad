import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DeviceKind } from '@lilypad/protocol';
import {
  DeviceRegistry,
  type DeviceIdentityStore,
  type DeviceRow,
  type DevicePlatform,
} from './deviceRegistry.js';

interface StoredDevice extends DeviceRow {
  publicKey: string | null;
  name: string | null;
  platform: DevicePlatform | null;
  lastSeenAt: Date | null;
}

function fakeStore(): DeviceIdentityStore & { rows: Map<string, StoredDevice> } {
  const rows = new Map<string, StoredDevice>();
  return {
    rows,
    findByPublicKey(publicKey) {
      for (const row of rows.values()) if (row.publicKey === publicKey) return Promise.resolve(row);
      return Promise.resolve(null);
    },
    findByFingerprint(kind, fingerprint) {
      for (const row of rows.values()) {
        if (row.kind === kind && row.fingerprint === fingerprint) return Promise.resolve(row);
      }
      return Promise.resolve(null);
    },
    /** Models the two unique indexes on `devices` (`devices_kind_fingerprint_idx`
     * and `devices_public_key_idx`, db/schema.ts) and the adapter's
     * `onConflictDoNothing`: a conflicting insert creates nothing and says so,
     * rather than raising. */
    create(row) {
      for (const existing of rows.values()) {
        const sameDevice = existing.kind === row.kind && existing.fingerprint === row.fingerprint;
        if (sameDevice || existing.publicKey === row.publicKey) return Promise.resolve(null);
      }
      const id = randomUUID();
      rows.set(id, { id, revokedAt: null, lastSeenAt: null, ...row });
      return Promise.resolve(id);
    },
    claim(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error('claim on a missing row');
      // Models the adapter's conditional WHERE: a row revoked at or after the
      // credential was minted is not claimable. Without this the fake would be
      // more permissive than Postgres, and the tests would prove nothing about
      // the guard that actually runs.
      if (
        patch.credentialIssuedAt != null &&
        row.revokedAt !== null &&
        row.revokedAt.getTime() >= patch.credentialIssuedAt.getTime()
      ) {
        return Promise.resolve(false);
      }
      row.userId = patch.userId;
      row.publicKey = patch.publicKey;
      row.revokedAt = null;
      if (patch.name !== null) row.name = patch.name;
      if (patch.platform !== null) row.platform = patch.platform;
      return Promise.resolve(true);
    },
    touchLastSeen(id) {
      const row = rows.get(id);
      if (row) row.lastSeenAt = new Date();
      return Promise.resolve();
    },
  };
}

/** A pre-account row, as `TrustService.upsertDevice` creates them: a
 * fingerprint and nothing else. */
function seedLegacyDevice(
  store: ReturnType<typeof fakeStore>,
  kind: DeviceKind,
  fingerprint: string,
): string {
  const id = randomUUID();
  store.rows.set(id, {
    id,
    userId: null,
    kind,
    fingerprint,
    revokedAt: null,
    publicKey: null,
    name: null,
    platform: null,
    lastSeenAt: null,
  });
  return id;
}

const enrollment = {
  userId: 'user-1',
  kind: 'desktop' as DeviceKind,
  fingerprint: 'desktop-abcdef',
  publicKey: 'key-one',
};

describe('DeviceRegistry.enroll', () => {
  let store: ReturnType<typeof fakeStore>;
  let registry: DeviceRegistry;

  beforeEach(() => {
    store = fakeStore();
    registry = new DeviceRegistry(store);
  });

  it('creates and owns a device on first enrollment', async () => {
    const result = await registry.enroll({ ...enrollment, name: 'Work Mac', platform: 'macos' });
    expect(result.ok).toBe(true);
    const row = store.rows.get(result.ok ? result.deviceId : '');
    expect(row).toMatchObject({ userId: 'user-1', publicKey: 'key-one', name: 'Work Mac' });
  });

  it('is idempotent for the same device and owner', async () => {
    const first = await registry.enroll(enrollment);
    const second = await registry.enroll(enrollment);
    expect(second).toEqual(first);
    expect(store.rows.size).toBe(1);
  });

  // The backfill path the schema was designed for: trust rows created before
  // accounts existed must survive the introduction of accounts.
  it('claims a pre-account row for the same fingerprint instead of orphaning it', async () => {
    const legacyId = seedLegacyDevice(store, 'desktop', 'desktop-abcdef');
    const result = await registry.enroll(enrollment);
    expect(result).toEqual({ ok: true, deviceId: legacyId, fingerprint: 'desktop-abcdef' });
    expect(store.rows.size).toBe(1);
    expect(store.rows.get(legacyId)).toMatchObject({ userId: 'user-1', publicKey: 'key-one' });
  });

  // Without this, anyone who learns a laptop's fingerprint enrolls it onto
  // their own account and inherits the machine.
  it('refuses to re-claim a device owned by another account', async () => {
    await registry.enroll(enrollment);
    const attacker = await registry.enroll({ ...enrollment, userId: 'user-2', publicKey: 'key-2' });
    expect(attacker).toEqual({ ok: false, reason: 'device_owned_by_another_account' });
    expect(store.rows.size).toBe(1);
  });

  /**
   * The same machine under a new name, which is what a partial wipe produces:
   * on macOS the fingerprint is a file in the app's data directory and the key
   * is in the login keychain, so clearing one and not the other renames a
   * computer without changing who it is (kanban L-153).
   *
   * This used to answer `public_key_in_use`, permanently — removing the device
   * from the account did not help, because revocation leaves the row and the
   * key still resolves. The key is the identity
   * ([ADR-0002](../../../../docs/adr/0002-device-identity.md)), so the existing
   * row wins.
   *
   * **The asserted fingerprint must be discarded, not written.** Every pair,
   * room and connect resolves through `devices.fingerprint`; rewriting it would
   * strand every phone already paired with this machine.
   */
  it('adopts a drifted fingerprint onto the row its key already owns', async () => {
    const first = await registry.enroll(enrollment);
    const renamed = await registry.enroll({
      ...enrollment,
      fingerprint: 'desktop-different',
      publicKey: 'key-one',
    });

    if (!first.ok || !renamed.ok) throw new Error('both enrollments must succeed');
    expect(renamed.deviceId).toBe(first.deviceId);
    expect(store.rows.size).toBe(1);
    // Told what it is really called, and the stored value is untouched.
    expect(renamed.fingerprint).toBe('desktop-abcdef');
    expect([...store.rows.values()][0]!.fingerprint).toBe('desktop-abcdef');
  });

  /** Drift is a rename, not a change of species. `claim` does not patch `kind`,
   * so adopting across kinds would leave the row and its client disagreeing
   * about what the device is. */
  it('refuses a key that would name both a laptop and a phone', async () => {
    await registry.enroll(enrollment);
    const crossKind = await registry.enroll({
      ...enrollment,
      kind: 'mobile' as DeviceKind,
      fingerprint: 'mobile-abcdef',
      publicKey: 'key-one',
    });
    expect(crossKind).toEqual({ ok: false, reason: 'public_key_in_use' });
  });

  it('refuses a key belonging to another account even on a fresh fingerprint', async () => {
    await registry.enroll(enrollment);
    const reused = await registry.enroll({
      userId: 'user-2',
      kind: 'mobile',
      fingerprint: 'mobile-xyz123',
      publicKey: 'key-one',
    });
    expect(reused).toEqual({ ok: false, reason: 'public_key_in_use' });
  });

  it('keeps desktop and mobile fingerprints in separate namespaces', async () => {
    const desktop = await registry.enroll(enrollment);
    const mobile = await registry.enroll({
      ...enrollment,
      kind: 'mobile',
      publicKey: 'key-two',
    });
    expect(mobile.ok).toBe(true);
    expect(mobile).not.toEqual(desktop);
    expect(store.rows.size).toBe(2);
  });

  it('re-enrolling rotates the key and lifts a revocation', async () => {
    const first = await registry.enroll(enrollment);
    if (!first.ok) throw new Error('unreachable');
    store.rows.get(first.deviceId)!.revokedAt = new Date();

    const again = await registry.enroll({ ...enrollment, publicKey: 'key-rotated' });
    expect(again).toEqual(first);
    expect(store.rows.get(first.deviceId)).toMatchObject({
      publicKey: 'key-rotated',
      revokedAt: null,
    });
  });

  it('does not erase a stored name when re-enrolling without one', async () => {
    const first = await registry.enroll({ ...enrollment, name: 'Work Mac', platform: 'macos' });
    if (!first.ok) throw new Error('unreachable');
    await registry.enroll(enrollment);
    expect(store.rows.get(first.deviceId)).toMatchObject({ name: 'Work Mac', platform: 'macos' });
  });

  /**
   * Two enrollments of the same device, in flight at once.
   *
   * `enroll` looks a device up and then inserts it, and the two unique indexes
   * on `devices` are what stop that from creating a second row. Reached in
   * practice by a retry: the phone abandons a request after 8 seconds
   * (`apps/mobile/src/lib/auth.ts`) while the server is still working, the user
   * taps Sign in again, and two enrollments for one fingerprint overlap. Both
   * lookups miss, both insert, and the loser used to raise a constraint
   * violation the route reported as a 500 — on the very first thing a new
   * account does.
   *
   * Both callers must end up on the SAME device row, because there is only one
   * device.
   */
  it('two concurrent enrollments of one device converge on a single row', async () => {
    const [a, b] = await Promise.all([registry.enroll(enrollment), registry.enroll(enrollment)]);
    if (!a.ok || !b.ok) throw new Error('both enrollments must succeed');
    expect(a.deviceId).toBe(b.deviceId);
    expect(store.rows.size).toBe(1);
  });

  /**
   * The same interleaving, with the racers disagreeing about what this machine
   * is called — the shape a partial wipe produces when the app is already
   * running. One key is one device, so both must converge on one row, and the
   * loser must be told the name that won rather than handed a 500.
   *
   * This expected `public_key_in_use` from the loser until 2026-08-25, back
   * when a key naming two fingerprints was treated as a conflict rather than as
   * a rename (kanban L-153).
   */
  it('two racers disagreeing about this machine’s name converge on one row', async () => {
    const [a, b] = await Promise.all([
      registry.enroll(enrollment),
      registry.enroll({ ...enrollment, fingerprint: 'desktop-other' }),
    ]);
    if (!a.ok || !b.ok) throw new Error('both must succeed: one key is one device');
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(store.rows.size).toBe(1);
  });
});

describe('re-enrolling a revoked device', () => {
  let store: ReturnType<typeof fakeStore>;
  let registry: DeviceRegistry;

  /** Enroll, then revoke, and hand back the moment of revocation. */
  async function enrolledThenRevokedAt(at: Date): Promise<void> {
    const first = await registry.enroll(enrollment);
    const row = store.rows.get(first.ok ? first.deviceId : '');
    row!.revokedAt = at;
  }

  beforeEach(() => {
    store = fakeStore();
    registry = new DeviceRegistry(store);
  });

  it('refuses a credential minted before the revocation', async () => {
    // The bug this closes, in order: revoke leaves the account session alive
    // (fixed separately), an account session is enough to call
    // `/devices/enroll`, and enrolling clears `revoked_at`. That last step is
    // what makes it permanent rather than a ten-minute window, so the last step
    // is where it stops.
    const revokedAt = new Date('2026-08-20T12:00:00Z');
    await enrolledThenRevokedAt(revokedAt);

    const result = await registry.enroll({
      ...enrollment,
      credentialIssuedAt: new Date('2026-08-20T11:59:00Z'),
    });

    expect(result).toEqual({ ok: false, reason: 'device_revoked' });
  });

  it('refuses a credential minted in the same second, because a tie is not proof', async () => {
    // `iat` has one-second resolution. A token stamped in the same second as
    // the revocation cannot be shown to be later, and the tie goes to the
    // person who pressed the button.
    const revokedAt = new Date('2026-08-20T12:00:00Z');
    await enrolledThenRevokedAt(revokedAt);

    const result = await registry.enroll({ ...enrollment, credentialIssuedAt: revokedAt });

    expect(result).toEqual({ ok: false, reason: 'device_revoked' });
  });

  it('accepts a credential minted after it, so the owner can sign back in', async () => {
    // The recovery path has to keep working, or the fix is a lockout: the owner
    // opens the app on the phone they still have, signs in, and the token they
    // get is newer than the revocation.
    const revokedAt = new Date('2026-08-20T12:00:00Z');
    await enrolledThenRevokedAt(revokedAt);

    const result = await registry.enroll({
      ...enrollment,
      credentialIssuedAt: new Date('2026-08-20T12:00:01Z'),
    });

    expect(result.ok).toBe(true);
    const row = store.rows.get(result.ok ? result.deviceId : '');
    expect(row?.revokedAt).toBeNull();
  });

  it('leaves the approval path alone, where another device is the proof', async () => {
    // `/devices/enrollment-code/approve` passes no `credentialIssuedAt`, and
    // must not: a desktop is restored by a DIFFERENT device approving its code,
    // and that second device IS the freshness check. Requiring the approver's
    // token to postdate the revocation would break the recovery it exists for
    // and add nothing — whoever holds the owner's phone has already won.
    await enrolledThenRevokedAt(new Date('2026-08-20T12:00:00Z'));

    const result = await registry.enroll(enrollment);

    expect(result.ok).toBe(true);
    const row = store.rows.get(result.ok ? result.deviceId : '');
    expect(row?.revokedAt).toBeNull();
  });

  it('loses to a revoke that lands between the lookup and the write', async () => {
    // The pre-check reads the row, then `claim` writes it: two round trips with
    // a gap in between. This drives a revocation into that gap and asserts the
    // WHERE clause still wins — the SELECT is advice, the UPDATE is the
    // decision. Same shape as `RefreshTokenService.markRotatedIfLive`.
    const issued = new Date('2026-08-20T12:00:00Z');
    const first = await registry.enroll(enrollment);
    const id = first.ok ? first.deviceId : '';

    const original = store.findByFingerprint.bind(store);
    store.findByFingerprint = async (kind, fingerprint) => {
      const row = await original(kind, fingerprint);
      // A SNAPSHOT, not the live object. The point of this test is that the
      // pre-check saw an unrevoked row and the write still lost; handing back
      // the live reference would let the pre-check see the revocation and the
      // test would pass without exercising the WHERE clause at all.
      const seen = row ? { ...row } : null;
      const live = store.rows.get(id);
      if (live) live.revokedAt = new Date('2026-08-20T12:00:30Z');
      return seen;
    };

    const racing = await registry.enroll({ ...enrollment, credentialIssuedAt: issued });

    expect(racing).toEqual({ ok: false, reason: 'device_revoked' });
    expect(store.rows.get(id)?.revokedAt).not.toBeNull();
  });

  it('does not get in the way of a device that was never revoked', async () => {
    await registry.enroll(enrollment);
    const again = await registry.enroll({ ...enrollment, credentialIssuedAt: new Date(0) });
    expect(again.ok).toBe(true);
  });
});

describe('DeviceRegistry.authenticate', () => {
  let store: ReturnType<typeof fakeStore>;
  let registry: DeviceRegistry;

  beforeEach(() => {
    store = fakeStore();
    registry = new DeviceRegistry(store);
  });

  it('resolves an enrolled key to its device and owner', async () => {
    const enrolled = await registry.enroll(enrollment);
    if (!enrolled.ok) throw new Error('unreachable');
    expect(await registry.authenticate('key-one')).toEqual({
      ok: true,
      deviceId: enrolled.deviceId,
      userId: 'user-1',
      // The row's own wire id, which is what lets a client whose local one has
      // drifted find out what it is really called.
      fingerprint: 'desktop-abcdef',
    });
  });

  it('records that the device was seen', async () => {
    const enrolled = await registry.enroll(enrollment);
    if (!enrolled.ok) throw new Error('unreachable');
    await registry.authenticate('key-one');
    expect(store.rows.get(enrolled.deviceId)?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('rejects an unknown key', async () => {
    expect(await registry.authenticate('never-enrolled')).toEqual({
      ok: false,
      reason: 'device_not_enrolled',
    });
  });

  it('rejects a revoked device', async () => {
    const enrolled = await registry.enroll(enrollment);
    if (!enrolled.ok) throw new Error('unreachable');
    store.rows.get(enrolled.deviceId)!.revokedAt = new Date();
    expect(await registry.authenticate('key-one')).toEqual({
      ok: false,
      reason: 'device_revoked',
    });
  });

  // A row with a key but no owner should be impossible; if it happens, the
  // gate must fail closed rather than mint a token with a null subject.
  it('rejects an ownerless row', async () => {
    const id = seedLegacyDevice(store, 'desktop', 'desktop-abcdef');
    store.rows.get(id)!.publicKey = 'orphan-key';
    expect(await registry.authenticate('orphan-key')).toEqual({
      ok: false,
      reason: 'device_not_enrolled',
    });
  });
});

describe('marking a device as seen', () => {
  /**
   * `last_seen_at` was written only by `authenticate`, the renew path. A device
   * that had just enrolled therefore read as never seen while holding a token
   * minted seconds earlier — observed in production on 2026-08-21, where a
   * phone the owner was physically holding sat at `last_seen_at IS NULL`.
   */
  it('touches last-seen for a device that never renewed', async () => {
    const store = fakeStore();
    const registry = new DeviceRegistry(store);
    const enrolled = await registry.enroll({
      userId: 'user-1',
      kind: 'mobile',
      fingerprint: 'mobile-abc',
      publicKey: 'key-1',
    });
    expect(enrolled.ok).toBe(true);

    const seen: string[] = [];
    store.touchLastSeen = async (id: string) => {
      seen.push(id);
    };
    if (!enrolled.ok) throw new Error('enroll failed');
    await registry.markSeen(enrolled.deviceId);

    expect(seen).toEqual([enrolled.deviceId]);
  });
});

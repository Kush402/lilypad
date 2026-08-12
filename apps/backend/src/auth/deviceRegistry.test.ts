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
    create(row) {
      const id = randomUUID();
      rows.set(id, { id, revokedAt: null, lastSeenAt: null, ...row });
      return Promise.resolve(id);
    },
    claim(id, patch) {
      const row = rows.get(id);
      if (!row) throw new Error('claim on a missing row');
      row.userId = patch.userId;
      row.publicKey = patch.publicKey;
      row.revokedAt = null;
      if (patch.name !== null) row.name = patch.name;
      if (patch.platform !== null) row.platform = patch.platform;
      return Promise.resolve();
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
    expect(result).toEqual({ ok: true, deviceId: legacyId });
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

  // A key that names two devices is not an identity.
  it('refuses a public key already bound to a different device', async () => {
    await registry.enroll(enrollment);
    const reused = await registry.enroll({
      ...enrollment,
      fingerprint: 'desktop-different',
      publicKey: 'key-one',
    });
    expect(reused).toEqual({ ok: false, reason: 'public_key_in_use' });
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

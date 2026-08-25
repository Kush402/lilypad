import { describe, it, expect } from 'vitest';
import type { AccountDevice } from '@lilypad/protocol';
import {
  AccountDeviceService,
  toAccountDevice,
  maskFingerprint,
  orderDevices,
  type AccountDeviceRow,
  type AccountDeviceStore,
} from './accountDevices.js';

const KEY = 'k'.repeat(43);

function row(over: Partial<AccountDeviceRow> = {}): AccountDeviceRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'mobile',
    platform: 'ios',
    name: 'ios phone',
    fingerprint: 'mobile-abcdef123456',
    userId: 'user-alice',
    publicKey: KEY,
    revokedAt: null,
    lastSeenAt: new Date('2026-08-13T10:00:00Z'),
    createdAt: new Date('2026-08-01T10:00:00Z'),
    ...over,
  };
}

class FakeStore implements AccountDeviceStore {
  rows: AccountDeviceRow[] = [];
  constructor(...rows: AccountDeviceRow[]) {
    this.rows = rows;
  }
  async listForUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }
  async rename(deviceId: string, name: string) {
    const found = this.rows.find((r) => r.id === deviceId);
    if (found) found.name = name;
  }
  async revoke(deviceId: string, at: Date) {
    const found = this.rows.find((r) => r.id === deviceId);
    // Mirrors the SQL guard: the first revoke is when access actually ended.
    if (found && found.revokedAt === null) found.revokedAt = at;
  }
  async fingerprintOf(deviceId: string) {
    return this.rows.find((r) => r.id === deviceId)?.fingerprint ?? null;
  }
}

const noneLive = () => false;

describe('maskFingerprint', () => {
  // A full fingerprint is an input to the pairing surface. A listing has no
  // reason to hand one out, and this matches what pair listings already do.
  it('shows only a short suffix', () => {
    expect(maskFingerprint('mobile-abcdef123456')).toBe('…123456');
  });

  it('leaves a short value alone rather than producing a misleading ellipsis', () => {
    expect(maskFingerprint('abc')).toBe('abc');
  });
});

describe('toAccountDevice', () => {
  it('derives state rather than inventing a fourth source of truth', () => {
    expect(toAccountDevice(row(), { activeSession: false, isCurrentDevice: false }).state).toBe(
      'linked',
    );
    expect(
      toAccountDevice(row({ revokedAt: new Date() }), {
        activeSession: false,
        isCurrentDevice: false,
      }).state,
    ).toBe('revoked');
    // Owned but keyless: it cannot prove it is itself, so it cannot act.
    expect(
      toAccountDevice(row({ publicKey: null }), { activeSession: false, isCurrentDevice: false })
        .state,
    ).toBe('unlinked');
  });

  it('serialises timestamps for the wire and tolerates a never-seen device', () => {
    const dto = toAccountDevice(row({ lastSeenAt: null }), {
      activeSession: false,
      isCurrentDevice: false,
    });
    expect(dto.lastSeenAt).toBeNull();
    expect(dto.createdAt).toBe('2026-08-01T10:00:00.000Z');
  });
});

describe('AccountDeviceService.list', () => {
  const alicePhone = row({ id: 'aaaaaaaa-1111-4111-8111-111111111111', userId: 'user-alice' });
  const aliceLaptop = row({
    id: 'aaaaaaaa-2222-4222-8222-222222222222',
    userId: 'user-alice',
    kind: 'desktop',
    platform: 'macos',
    fingerprint: 'desktop-zzzzzz999999',
  });
  const bobPhone = row({ id: 'bbbbbbbb-1111-4111-8111-111111111111', userId: 'user-bob' });

  it("lists only the caller's account, never another's", async () => {
    const service = new AccountDeviceService(new FakeStore(alicePhone, aliceLaptop, bobPhone));
    const list = await service.list('user-alice', null, noneLive);
    expect(list.map((d) => d.id)).toEqual([alicePhone.id, aliceLaptop.id]);
  });

  // So a client can say "this phone" and warn before revoking what it holds.
  it('marks the calling device as the current one', async () => {
    const service = new AccountDeviceService(new FakeStore(alicePhone, aliceLaptop));
    const list = await service.list('user-alice', alicePhone.id, noneLive);
    expect(list.find((d) => d.id === alicePhone.id)?.isCurrentDevice).toBe(true);
    expect(list.find((d) => d.id === aliceLaptop.id)?.isCurrentDevice).toBe(false);
  });

  // Liveness is asked per device by (kind, fingerprint) — the hub is keyed by
  // wire fingerprint, not by these uuids, and asking with the uuid would
  // silently report every device idle.
  it('asks about liveness with the wire fingerprint and the device kind', async () => {
    const asked: Array<[string, string]> = [];
    const service = new AccountDeviceService(new FakeStore(alicePhone, aliceLaptop));
    const list = await service.list('user-alice', null, (kind, fingerprint) => {
      asked.push([kind, fingerprint]);
      return fingerprint === aliceLaptop.fingerprint;
    });
    expect(asked).toEqual([
      ['mobile', alicePhone.fingerprint],
      ['desktop', aliceLaptop.fingerprint],
    ]);
    expect(list.find((d) => d.id === aliceLaptop.id)?.activeSession).toBe(true);
    expect(list.find((d) => d.id === alicePhone.id)?.activeSession).toBe(false);
  });
});

describe('AccountDeviceService.revoke', () => {
  it("returns the wire fingerprint, so the caller can end that device's rooms", async () => {
    const device = row();
    const service = new AccountDeviceService(new FakeStore(device));
    const at = new Date('2026-08-13T12:00:00Z');

    expect(await service.revoke(device.id, at)).toEqual({ fingerprint: device.fingerprint });
    expect(device.revokedAt).toEqual(at);
  });

  // The first revoke is when access actually ended; a second must not move it,
  // or the audit trail would say the machine was reachable longer than it was.
  it('does not move the timestamp on a repeat revoke', async () => {
    const first = new Date('2026-08-13T12:00:00Z');
    const device = row({ revokedAt: first });
    const service = new AccountDeviceService(new FakeStore(device));

    await service.revoke(device.id, new Date('2026-08-13T18:00:00Z'));
    expect(device.revokedAt).toEqual(first);
  });

  it('answers null for an unknown device rather than pretending it worked', async () => {
    const service = new AccountDeviceService(new FakeStore());
    expect(await service.revoke('99999999-9999-4999-8999-999999999999')).toBeNull();
  });
});

describe('AccountDeviceService.rename', () => {
  it('renames only the named device', async () => {
    const a = row({ id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'ios phone' });
    const b = row({ id: 'bbbbbbbb-1111-4111-8111-111111111111', name: 'other phone' });
    const service = new AccountDeviceService(new FakeStore(a, b));

    await service.rename(a.id, 'Work phone');

    expect(a.name).toBe('Work phone');
    expect(b.name).toBe('other phone');
  });
});

/**
 * The order the list is read in.
 *
 * `listForUser` had no ORDER BY, so the phone rendered the heap order: a
 * screenshot on 2026-08-24 ran 2m, 1m, 3d, 33h, 7h down the screen, and the
 * device the person was holding was second. Nothing about that is wrong per
 * row — it is wrong as a list.
 */
describe('orderDevices', () => {
  const device = (over: Partial<AccountDevice>): AccountDevice => ({
    ...toAccountDevice(row(), { activeSession: false, isCurrentDevice: false }),
    ...over,
  });

  const at = (iso: string) => ({ lastSeenAt: iso });

  it('puts the device you are holding first, whatever its clock says', () => {
    const older = device({ id: 'a', ...at('2026-08-20T10:00:00Z'), isCurrentDevice: true });
    const newer = device({ id: 'b', ...at('2026-08-24T10:00:00Z') });
    expect(orderDevices([newer, older]).map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('then the ones in a session right now', () => {
    const live = device({ id: 'live', ...at('2026-08-01T10:00:00Z'), activeSession: true });
    const recent = device({ id: 'recent', ...at('2026-08-24T10:00:00Z') });
    expect(orderDevices([recent, live]).map((d) => d.id)).toEqual(['live', 'recent']);
  });

  it('then most recently seen, which is the order the screenshot lacked', () => {
    const rows = [
      device({ id: '3d', ...at('2026-08-21T10:00:00Z') }),
      device({ id: '1m', ...at('2026-08-24T09:59:00Z') }),
      device({ id: '33h', ...at('2026-08-23T01:00:00Z') }),
      device({ id: '7h', ...at('2026-08-24T03:00:00Z') }),
    ];
    expect(orderDevices(rows).map((d) => d.id)).toEqual(['1m', '7h', '33h', '3d']);
  });

  it('sinks a device that has never connected below every one that has', () => {
    const never = device({ id: 'never', lastSeenAt: null });
    const ancient = device({ id: 'ancient', ...at('2020-01-01T00:00:00Z') });
    expect(orderDevices([never, ancient]).map((d) => d.id)).toEqual(['ancient', 'never']);
  });

  it('sinks a revoked device even when it is the one asking', () => {
    // Revoked rows are history. History above a live device is a list that
    // misleads at a glance.
    const gone = device({
      id: 'gone',
      state: 'revoked',
      isCurrentDevice: true,
      ...at('2026-08-24T10:00:00Z'),
    });
    const live = device({ id: 'live', ...at('2020-01-01T00:00:00Z') });
    expect(orderDevices([gone, live]).map((d) => d.id)).toEqual(['live', 'gone']);
  });

  it('does not mutate what it was given', () => {
    const rows = [
      device({ id: 'b', ...at('2026-08-01T10:00:00Z') }),
      device({ id: 'a', ...at('2026-08-24T10:00:00Z') }),
    ];
    orderDevices(rows);
    expect(rows.map((d) => d.id)).toEqual(['b', 'a']);
  });
});

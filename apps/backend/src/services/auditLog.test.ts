import { describe, it, expect } from 'vitest';
import { AuditLogService, type AuditLogStore } from './auditLog.js';

/** In-memory fake store, mirroring `FakeKv`/`FakePairingRedis`'s style
 * elsewhere in this codebase. */
class FakeAuditLogStore implements AuditLogStore {
  rows: Parameters<AuditLogStore['insert']>[0][] = [];
  async insert(row: Parameters<AuditLogStore['insert']>[0]) {
    this.rows.push(row);
  }
}

/** A store whose writes always fail — used to prove the service itself does
 * NOT swallow errors; the fire-and-forget/best-effort contract is the
 * CALLER's responsibility (`void auditLog.x(...).catch(...)`), same as
 * `SessionManager`/`RoomStore`. */
class FailingAuditLogStore implements AuditLogStore {
  async insert(): Promise<void> {
    throw new Error('db unavailable');
  }
}

describe('AuditLogService', () => {
  it('writes a device_paired row with the given metadata/ip and null user/device FKs', async () => {
    const store = new FakeAuditLogStore();
    const service = new AuditLogService(store);

    await service.devicePaired({
      ip: '203.0.113.5',
      metadata: { roomId: 'room-1', mobileDeviceId: 'mobile-01' },
    });

    expect(store.rows).toEqual([
      {
        eventType: 'device_paired',
        userId: null,
        deviceId: null,
        ip: '203.0.113.5',
        metadata: { roomId: 'room-1', mobileDeviceId: 'mobile-01' },
      },
    ]);
  });

  it('writes a session_start row', async () => {
    const store = new FakeAuditLogStore();
    const service = new AuditLogService(store);

    await service.sessionStart({
      metadata: { sessionId: 'sess-1', roomId: 'room-1', scopes: ['view', 'control'] },
    });

    expect(store.rows).toEqual([
      {
        eventType: 'session_start',
        userId: null,
        deviceId: null,
        ip: null,
        metadata: { sessionId: 'sess-1', roomId: 'room-1', scopes: ['view', 'control'] },
      },
    ]);
  });

  it('writes a session_end row', async () => {
    const store = new FakeAuditLogStore();
    const service = new AuditLogService(store);

    await service.sessionEnd({ metadata: { sessionId: 'sess-1', reason: 'mobile disconnected' } });

    expect(store.rows).toEqual([
      {
        eventType: 'session_end',
        userId: null,
        deviceId: null,
        ip: null,
        metadata: { sessionId: 'sess-1', reason: 'mobile disconnected' },
      },
    ]);
  });

  it('writes a pair_denied row', async () => {
    const store = new FakeAuditLogStore();
    const service = new AuditLogService(store);

    await service.pairDenied({
      metadata: { roomId: 'room-1', reason: 'not now' },
    });

    expect(store.rows).toEqual([
      {
        eventType: 'pair_denied',
        userId: null,
        deviceId: null,
        ip: null,
        metadata: { roomId: 'room-1', reason: 'not now' },
      },
    ]);
  });

  it('defaults metadata to {} and userId/deviceId/ip to null when omitted entirely', async () => {
    const store = new FakeAuditLogStore();
    const service = new AuditLogService(store);

    await service.sessionStart();

    expect(store.rows).toEqual([
      { eventType: 'session_start', userId: null, deviceId: null, ip: null, metadata: {} },
    ]);
  });

  it("propagates a store failure instead of swallowing it — best-effort is the caller's job", async () => {
    const service = new AuditLogService(new FailingAuditLogStore());

    await expect(service.sessionEnd({ metadata: { sessionId: 's' } })).rejects.toThrow(
      'db unavailable',
    );
  });

  it('a rejected write does not throw synchronously when used fire-and-forget, matching the void(...).catch(...) call sites', () => {
    const service = new AuditLogService(new FailingAuditLogStore());

    // This is exactly the pattern used at every real call site (routes/pairing.ts,
    // routes/signaling.ts): the caller never awaits, so a DB blip can't block or
    // throw into signaling/pairing regardless of how the promise settles.
    expect(() => {
      void service.sessionEnd({ metadata: { sessionId: 's' } }).catch(() => undefined);
    }).not.toThrow();
  });
});

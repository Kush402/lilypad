import { describe, it, expect } from 'vitest';
import { attributeSession } from './ownership.js';
import type { DeviceOwnership } from './ownership.js';

/**
 * `audit_logs` has one `user_id` and one `device_id`; a session has two
 * devices. This is the choice, and it was previously not made at all — 21 of
 * 21 session rows in production carried both fields NULL on 2026-08-21, so
 * "what connected to my Mac, and whose account was it" could not be answered
 * from the audit log.
 */

const owned = (over: Partial<DeviceOwnership> = {}): DeviceOwnership => ({
  deviceId: 'dev-uuid',
  userId: 'user-1',
  state: 'linked',
  ...over,
});

describe('who a session audit row names', () => {
  it('names the phone as the device, because the phone is what connected', () => {
    const actor = attributeSession(
      owned({ deviceId: 'desktop-row' }),
      owned({ deviceId: 'mobile-row' }),
    );
    expect(actor.deviceId).toBe('mobile-row');
    expect(actor.userId).toBe('user-1');
  });

  /**
   * `authorize.ts`'s unowned lane still admits a phone no account owns. The
   * session it opens still reaches somebody's Mac, and that somebody is the
   * one person entitled to see it in an audit log.
   */
  it("falls back to the Mac's owner when the phone belongs to no account", () => {
    const actor = attributeSession(
      owned({ deviceId: 'desktop-row', userId: 'mac-owner' }),
      owned({ deviceId: 'mobile-row', userId: null }),
    );
    expect(actor.userId).toBe('mac-owner');
    expect(actor.deviceId).toBe('mobile-row');
  });

  it('reports null rather than guessing when neither side is owned', () => {
    const actor = attributeSession(owned({ userId: null }), owned({ userId: null }));
    expect(actor.userId).toBeNull();
  });

  // The hub's own types make both device ids nullable: a room can reach
  // `onSessionStart` before it has learned a seat's device id.
  it('survives a session whose devices could not be resolved', () => {
    expect(attributeSession(null, null)).toEqual({ userId: null, deviceId: null });
  });

  it('still names the account when only the desktop resolved', () => {
    expect(attributeSession(owned({ userId: 'mac-owner' }), null)).toEqual({
      userId: 'mac-owner',
      deviceId: null,
    });
  });

  it('never names a revoked phone as somebody it is not', () => {
    // A revoked device keeps its owner: revocation withdraws access, not
    // history. The audit trail must still say whose machine this was.
    const actor = attributeSession(owned(), owned({ deviceId: 'mobile-row', state: 'revoked' }));
    expect(actor).toEqual({ userId: 'user-1', deviceId: 'mobile-row' });
  });
});

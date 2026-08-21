import { describe, it, expect } from 'vitest';
import {
  ConnectRequestSchema,
  DesktopEnrollmentApprovedSchema,
  DevicePairsQuerySchema,
  UnpairRequestSchema,
  WireDeviceIdSchema,
} from './index.js';

/**
 * A device has two ids and they are not interchangeable:
 *
 * - `devices.id` — an internal Postgres uuid, used by account-scoped routes.
 * - `devices.fingerprint` — the WIRE id, resolved by every pair-scoped route.
 *
 * Confusing them cost the product its whole reason to exist for a release:
 * `/devices/enrollment-code/approve` returned the uuid under a field the phone
 * stored as the wire id, so `/connect/request` answered `404 not_trusted` and
 * `/devices/unpair` answered `200 ok` and severed nothing — both about a
 * pairing that was live, unrevoked, and holding a valid secret.
 *
 * Both clients have always minted `desktop-<uuid>` / `mobile-<random>`, so the
 * two namespaces are distinguishable by shape. These tests are what makes the
 * shape load-bearing instead of a convention.
 */

const FINGERPRINT = 'desktop-b31d4eed-d318-4e37-ba08-9a1f76349290';
const ROW_UUID = '3c927336-81f0-4564-b7d6-1fe58e053795';

describe('WireDeviceIdSchema', () => {
  it('accepts what the clients actually mint', () => {
    expect(WireDeviceIdSchema.safeParse(FINGERPRINT).success).toBe(true);
    expect(WireDeviceIdSchema.safeParse('mobile-kqmqmoiq6vfff6e9msutl').success).toBe(true);
  });

  it('rejects a devices.id uuid', () => {
    // The whole point: this used to parse, and the request then 404'd with a
    // message blaming the user's pairing.
    expect(WireDeviceIdSchema.safeParse(ROW_UUID).success).toBe(false);
  });
});

describe('the routes that resolve a fingerprint', () => {
  const uuidBody = { desktopDeviceId: ROW_UUID, mobileDeviceId: 'mobile-kqmqmoiq6vfff6e9msutl' };
  const wireBody = { desktopDeviceId: FINGERPRINT, mobileDeviceId: 'mobile-kqmqmoiq6vfff6e9msutl' };

  it('refuse a uuid rather than answering "not trusted" about a live pair', () => {
    expect(ConnectRequestSchema.safeParse(uuidBody).success).toBe(false);
    expect(UnpairRequestSchema.safeParse(uuidBody).success).toBe(false);
    expect(DevicePairsQuerySchema.safeParse({ desktopDeviceId: ROW_UUID }).success).toBe(false);
  });

  it('accept a wire id', () => {
    expect(ConnectRequestSchema.safeParse(wireBody).success).toBe(true);
    expect(UnpairRequestSchema.safeParse(wireBody).success).toBe(true);
    expect(DevicePairsQuerySchema.safeParse({ desktopDeviceId: FINGERPRINT }).success).toBe(true);
  });
});

describe('the approve response', () => {
  const base = {
    ok: true as const,
    deviceId: ROW_UUID,
    name: 'MacBook Pro',
    platform: 'macos' as const,
    pairSecret: 's'.repeat(32),
  };

  it('keeps the two ids in fields that mean what they say', () => {
    const parsed = DesktopEnrollmentApprovedSchema.parse({
      ...base,
      desktopDeviceId: FINGERPRINT,
    });
    expect(parsed.deviceId).toBe(ROW_UUID);
    expect(parsed.desktopDeviceId).toBe(FINGERPRINT);
  });

  it('refuses to carry the uuid in the wire-id field', () => {
    expect(
      DesktopEnrollmentApprovedSchema.safeParse({ ...base, desktopDeviceId: ROW_UUID }).success,
    ).toBe(false);
  });

  it('still parses without the wire id, for a phone on an older backend', () => {
    // Such a phone links the laptop and cannot remember it — degraded, but it
    // must not fail to parse and lose the link entirely.
    expect(DesktopEnrollmentApprovedSchema.safeParse(base).success).toBe(true);
  });
});

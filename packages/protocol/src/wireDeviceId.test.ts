import { describe, it, expect } from 'vitest';
import {
  ConnectRequestSchema,
  DesktopEnrollmentApprovedSchema,
  DeviceEnrollRequestSchema,
  DevicePairsQuerySchema,
  PairingCreateRequestSchema,
  PairingRedeemRequestSchema,
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

/**
 * The rule has to hold where the id ENTERS, not only where it is resolved.
 *
 * It did not. `/connect/request`, `/devices/unpair` and `/devices/pairs` all
 * checked the shape; `/devices/enroll`, `/pairing/create` and `/pairing/redeem`
 * took `z.string().min(8)`. So a client could enroll as `mac-abc123`, pair,
 * and show up on the account as linked — and then never connect, because
 * `/connect/request` answered `400 invalid_request` to the exact id enrollment
 * had accepted. `scripts/e2e-audit.mjs` was minting that shape and carrying
 * four unexplained failures because of it.
 *
 * Production held two devices when this was tightened, `desktop-e066…` and
 * `mobile-kqmqm…`, so nothing real was excluded.
 */
describe('the routes where a wire id first arrives', () => {
  const proof = {
    challenge: 'c'.repeat(32),
    publicKey: 'p'.repeat(43),
    signature: 's'.repeat(86),
  };
  const enroll = (fingerprint: string) => ({ ...proof, kind: 'desktop' as const, fingerprint });

  it('refuse a shape that a later route would reject', () => {
    // `mac-` is not a namespace this product has. It parsed here and failed at
    // the one place it mattered.
    expect(DeviceEnrollRequestSchema.safeParse(enroll('mac-abc12345')).success).toBe(false);
    expect(PairingCreateRequestSchema.safeParse({ deviceId: 'mac-abc12345' }).success).toBe(false);
    expect(
      PairingRedeemRequestSchema.safeParse({ token: 't'.repeat(20), deviceId: 'phone-abc12345' })
        .success,
    ).toBe(false);
  });

  it('refuse a devices.id uuid, the failure that started all of this', () => {
    expect(DeviceEnrollRequestSchema.safeParse(enroll(ROW_UUID)).success).toBe(false);
    expect(PairingCreateRequestSchema.safeParse({ deviceId: ROW_UUID }).success).toBe(false);
  });

  it('accept what both clients mint, which is what production holds', () => {
    expect(DeviceEnrollRequestSchema.safeParse(enroll(FINGERPRINT)).success).toBe(true);
    expect(PairingCreateRequestSchema.safeParse({ deviceId: FINGERPRINT }).success).toBe(true);
    expect(
      PairingRedeemRequestSchema.safeParse({
        token: 't'.repeat(20),
        deviceId: 'mobile-kqmqmoiq6vfff6e9msutl',
      }).success,
    ).toBe(true);
  });
});

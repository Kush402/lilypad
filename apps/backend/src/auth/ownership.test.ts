import { describe, it, expect } from 'vitest';
import { ownsDevice, canManagePair, type DeviceOwnership } from './ownership.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';

function device(userId: string | null): DeviceOwnership {
  return { deviceId: `dev-${userId ?? 'none'}`, userId, state: userId ? 'linked' : 'unlinked' };
}

describe('ownsDevice', () => {
  it('lets an owner through', () => {
    expect(ownsDevice(ALICE, device(ALICE))).toBe(true);
  });

  // The whole point of SEC-3: knowing an identifier must never be enough.
  it("refuses another account's device", () => {
    expect(ownsDevice(BOB, device(ALICE))).toBe(false);
  });

  // An unowned row belongs to NOBODY, not to whoever asks first. Enrolling
  // claims such a row; merely asking about it never does — otherwise the first
  // caller to guess a pre-accounts fingerprint would inherit it.
  it('refuses an unowned device rather than treating it as unclaimed territory', () => {
    expect(ownsDevice(ALICE, device(null))).toBe(false);
    expect(ownsDevice(BOB, device(null))).toBe(false);
  });
});

describe('canManagePair', () => {
  const alicePhone = device(ALICE);
  const aliceLaptop = device(ALICE);
  const bobPhone = device(BOB);
  const bobLaptop = device(BOB);

  it('lets the owner of either side manage the pair', () => {
    const pair = { pairId: 'p1', desktop: aliceLaptop, mobile: alicePhone };
    expect(canManagePair(ALICE, pair)).toBe(true);
  });

  // Both directions matter: the laptop's owner says "stop trusting this
  // phone", the phone's owner says "forget this laptop". Either may sever it.
  it('lets the phone-side owner sever a cross-account pair', () => {
    const shared = { pairId: 'p2', desktop: aliceLaptop, mobile: bobPhone };
    expect(canManagePair(BOB, shared)).toBe(true);
    expect(canManagePair(ALICE, shared)).toBe(true);
  });

  it('refuses a third party who owns neither side', () => {
    const pair = { pairId: 'p3', desktop: aliceLaptop, mobile: alicePhone };
    expect(canManagePair('user-carol', pair)).toBe(false);
  });

  // The precise attack SEC-3 describes: Bob knows (or guesses) the pair uuid
  // of Alice's laptop and her phone, and calls DELETE /devices/pairs/:pairId.
  // Before ownership checks existed this revoked her pair and killed her live
  // session. Knowing the identifier must not be sufficient.
  it("refuses to let one account revoke another account's pair by id", () => {
    const alicesPair = { pairId: 'p4', desktop: aliceLaptop, mobile: alicePhone };
    expect(canManagePair(BOB, alicesPair)).toBe(false);
  });

  it('refuses when both sides are unowned', () => {
    const orphan = { pairId: 'p5', desktop: device(null), mobile: device(null) };
    expect(canManagePair(ALICE, orphan)).toBe(false);
  });

  it("does not let Bob's ownership of his own devices leak into Alice's pair", () => {
    const bobsPair = { pairId: 'p6', desktop: bobLaptop, mobile: bobPhone };
    expect(canManagePair(ALICE, bobsPair)).toBe(false);
    expect(canManagePair(BOB, bobsPair)).toBe(true);
  });
});

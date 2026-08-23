import { describe, it, expect } from 'vitest';
import { actAsDevice, manageDevice, managePair, type Access } from './authorize.js';
import type { DeviceOwnership, PairOwnership } from './ownership.js';
import type { Actor } from './tokens.js';

/**
 * SEC-7 — cross-user isolation, table-driven.
 *
 * The property under test is one sentence: **no request Bob can construct
 * reaches anything Alice owns.** These run against the pure rule every route
 * applies, so a route is covered the moment it calls this — and the route
 * wiring itself (that each one actually calls it) is asserted separately in
 * `routes/authorization.test.ts`.
 */

const ALICE = 'user-alice';
const BOB = 'user-bob';

const aliceLaptop: DeviceOwnership = { deviceId: 'dev-a-laptop', userId: ALICE, state: 'linked' };
const alicePhone: DeviceOwnership = { deviceId: 'dev-a-phone', userId: ALICE, state: 'linked' };
const bobPhone: DeviceOwnership = { deviceId: 'dev-b-phone', userId: BOB, state: 'linked' };
const unowned: DeviceOwnership = { deviceId: 'dev-legacy', userId: null, state: 'unlinked' };
const revokedAliceLaptop: DeviceOwnership = { ...aliceLaptop, state: 'revoked' };

/** A device token, as `/devices/token` mints it. */
const asDevice = (userId: string, deviceId: string): Actor => ({ userId, deviceId });
/** An account session — signed in, but not an enrolled device (the web
 * dashboard, P4). It knows who you are, never which machine you are. */
const asAccount = (userId: string): Actor => ({ userId, deviceId: null });

const allowed = (a: Access) => a.allow;

describe('actAsDevice — the caller must BE the device it names', () => {
  it('lets a device act as itself', () => {
    expect(actAsDevice(asDevice(ALICE, aliceLaptop.deviceId), aliceLaptop)).toEqual({
      allow: true,
      lane: 'owner',
    });
  });

  // The core SEC-3 claim: an identifier in a request body buys nothing.
  it('refuses an anonymous caller that merely names a linked device', () => {
    expect(allowed(actAsDevice(null, aliceLaptop))).toBe(false);
  });

  it("refuses another account's device", () => {
    expect(allowed(actAsDevice(asDevice(BOB, bobPhone.deviceId), aliceLaptop))).toBe(false);
  });

  // Owning a machine is not being it. Alice's PHONE may manage her laptop's
  // pairs, but it may not ring a laptop while pretending to be that laptop —
  // otherwise one compromised device could impersonate every sibling.
  it("refuses the owner's OTHER device acting as this one", () => {
    expect(allowed(actAsDevice(asDevice(ALICE, alicePhone.deviceId), aliceLaptop))).toBe(false);
  });

  // An account token proves a human, not a machine. Enrolment (`requireDevice`)
  // is where that distinction is already enforced; it holds here too.
  it('refuses an account session with no device of its own', () => {
    expect(allowed(actAsDevice(asAccount(ALICE), aliceLaptop))).toBe(false);
  });

  it('refuses a revoked device acting as itself', () => {
    expect(
      allowed(actAsDevice(asDevice(ALICE, revokedAliceLaptop.deviceId), revokedAliceLaptop)),
    ).toBe(false);
  });

  // A token whose subject no longer owns the row it names — the device was
  // re-enrolled onto another account under a stale token.
  it('refuses a token whose device id matches but whose account no longer owns it', () => {
    expect(allowed(actAsDevice(asDevice(BOB, aliceLaptop.deviceId), aliceLaptop))).toBe(false);
  });

  /**
   * The product model is account -> devices: a device that belongs to no
   * account is not a device with fewer privileges, it is a device that cannot
   * act, because there is nobody on whose behalf it would act.
   *
   * This used to ALLOW, described in the source as a migration ramp that would
   * close "once P1 makes enrolment mandatory". P1 chose the opposite
   * ("linking is offered, not demanded"), so the ramp had become permanent and
   * knowing a fingerprint was enough to act as any unlinked device.
   */
  it('refuses a device on no account, even to itself', () => {
    expect(actAsDevice(null, unowned)).toEqual({ allow: false });
    expect(actAsDevice(alicePhone, unowned)).toEqual({ allow: false });
  });

  it('refuses a device it has never heard of', () => {
    expect(actAsDevice(null, null)).toEqual({ allow: false });
    expect(actAsDevice(alicePhone, null)).toEqual({ allow: false });
  });
});

describe('manageDevice — the caller must OWN the device', () => {
  it("lets any of the owner's devices manage it", () => {
    expect(allowed(manageDevice(asDevice(ALICE, alicePhone.deviceId), aliceLaptop))).toBe(true);
    expect(allowed(manageDevice(asAccount(ALICE), aliceLaptop))).toBe(true);
  });

  it('refuses another account and an anonymous caller alike', () => {
    expect(allowed(manageDevice(asDevice(BOB, bobPhone.deviceId), aliceLaptop))).toBe(false);
    expect(allowed(manageDevice(null, aliceLaptop))).toBe(false);
  });

  // Deliberately different from `actAsDevice`: "I lost my laptop" must not
  // also mean "and now you cannot clean up after it".
  it('still lets an owner manage a REVOKED device', () => {
    expect(allowed(manageDevice(asDevice(ALICE, alicePhone.deviceId), revokedAliceLaptop))).toBe(
      true,
    );
  });

  it('refuses to manage a device on no account, or one that does not exist', () => {
    expect(manageDevice(null, unowned)).toEqual({ allow: false });
    expect(manageDevice(alicePhone, unowned)).toEqual({ allow: false });
    expect(manageDevice(alicePhone, null)).toEqual({ allow: false });
  });
});

describe('managePair — either side of the relationship', () => {
  const alicesPair: PairOwnership = { pairId: 'p1', desktop: aliceLaptop, mobile: alicePhone };
  const shared: PairOwnership = { pairId: 'p2', desktop: aliceLaptop, mobile: bobPhone };
  const orphan: PairOwnership = { pairId: 'p3', desktop: unowned, mobile: unowned };
  const halfOwned: PairOwnership = { pairId: 'p4', desktop: aliceLaptop, mobile: unowned };

  it('lets the owner of either side manage it', () => {
    expect(allowed(managePair(asDevice(ALICE, alicePhone.deviceId), alicesPair))).toBe(true);
    expect(allowed(managePair(asDevice(BOB, bobPhone.deviceId), shared))).toBe(true);
    expect(allowed(managePair(asDevice(ALICE, aliceLaptop.deviceId), shared))).toBe(true);
  });

  // The exact attack: Bob knows a pair uuid and calls DELETE. Before M9 this
  // revoked the pair and force-ended its live session.
  it("refuses one account revoking another's pair by id", () => {
    expect(allowed(managePair(asDevice(BOB, bobPhone.deviceId), alicesPair))).toBe(false);
    expect(allowed(managePair(null, alicesPair))).toBe(false);
  });

  // One owned side is enough to make the relationship someone's business —
  // otherwise pairing a linked laptop with an unenrolled phone would reopen
  // the whole surface.
  it('treats a half-owned pair as owned, not unowned', () => {
    expect(managePair(asDevice(ALICE, aliceLaptop.deviceId), halfOwned)).toEqual({
      allow: true,
      lane: 'owner',
    });
    expect(allowed(managePair(asDevice(BOB, bobPhone.deviceId), halfOwned))).toBe(false);
    expect(allowed(managePair(null, halfOwned))).toBe(false);
  });

  it('refuses a pair with an owner on neither side', () => {
    expect(managePair(null, orphan)).toEqual({ allow: false });
    expect(managePair(alicePhone, orphan)).toEqual({ allow: false });
    expect(managePair(alicePhone, null)).toEqual({ allow: false });
  });

  // Half-owned must keep working: it is the shape a pair takes the instant one
  // side links, and the owned side's account is entitled to manage it.
  it('still lets the owned side manage a half-owned pair', () => {
    expect(managePair(alicePhone, halfOwned)).toEqual({ allow: true, lane: 'owner' });
  });
});

describe('SEC-7 — Bob reaches nothing of Alice, on any route', () => {
  const bobActors = [
    ['anonymous', null],
    ["Bob's phone", asDevice(BOB, bobPhone.deviceId)],
    ["Bob's account session", asAccount(BOB)],
    // Guessing Alice's device uuid does not help either: the token still has
    // to be signed for Bob, and the row is still Alice's.
    ["Bob holding Alice's device uuid", asDevice(BOB, aliceLaptop.deviceId)],
  ] as const;

  const aliceResources = [
    ['GET /devices/pairs (her laptop)', (a: Actor | null) => manageDevice(a, aliceLaptop)],
    [
      'PATCH /devices/pairs/:id',
      (a: Actor | null) => managePair(a, { pairId: 'p', desktop: aliceLaptop, mobile: alicePhone }),
    ],
    [
      'DELETE /devices/pairs/:id',
      (a: Actor | null) => managePair(a, { pairId: 'p', desktop: aliceLaptop, mobile: alicePhone }),
    ],
    ['POST /devices/unpair (her phone)', (a: Actor | null) => actAsDevice(a, alicePhone)],
    ['POST /connect/request (her phone)', (a: Actor | null) => actAsDevice(a, alicePhone)],
    ['POST /pairing/create (her laptop)', (a: Actor | null) => actAsDevice(a, aliceLaptop)],
    ['POST /pairing/redeem (her phone)', (a: Actor | null) => actAsDevice(a, alicePhone)],
    ['WS register presence:<her laptop>', (a: Actor | null) => actAsDevice(a, aliceLaptop)],
  ] as const;

  for (const [who, actor] of bobActors) {
    for (const [route, decide] of aliceResources) {
      it(`${who} is refused ${route}`, () => {
        expect(allowed(decide(actor))).toBe(false);
      });
    }
  }

  it("Alice's own devices still reach all of it", () => {
    expect(allowed(manageDevice(asDevice(ALICE, aliceLaptop.deviceId), aliceLaptop))).toBe(true);
    expect(allowed(actAsDevice(asDevice(ALICE, alicePhone.deviceId), alicePhone))).toBe(true);
    expect(allowed(actAsDevice(asDevice(ALICE, aliceLaptop.deviceId), aliceLaptop))).toBe(true);
  });
});

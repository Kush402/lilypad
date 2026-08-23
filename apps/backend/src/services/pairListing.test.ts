import { describe, it, expect } from 'vitest';
import {
  toPairListing,
  toMobilePairListing,
  type PairListingRow,
  type MobilePairListingRow,
} from './trust.js';

/**
 * What the Trusted Devices dashboard is allowed to show for a pair.
 *
 * The in-memory `TrustStore` fake used by `trust.test.ts` returns finished
 * `PairListing`s, so it never exercised this mapping — which is how the naming
 * bug below survived into production unnoticed.
 */

const row = (over: Partial<PairListingRow> = {}): PairListingRow => ({
  pairId: 'pair-1',
  mobileFingerprint: 'mobile-kqmqmoiq6vfff6e9msutlmuu',
  displayName: null,
  deviceName: 'ios phone',
  autoApprove: true,
  revokedAt: null,
  lastConnectedAt: null,
  createdAt: new Date('2026-08-21T20:57:35.524Z'),
  ...over,
});

describe('which name a paired phone is shown under', () => {
  /**
   * The exact row production held after a real first-run test on 2026-08-21:
   * display_name NULL, devices.name 'ios phone'. The dashboard rendered
   * `pair.displayName ?? 'Phone'`, so it said "Phone".
   */
  it("uses the phone's own name when the pair has no nickname", () => {
    expect(toPairListing(row()).displayName).toBe('ios phone');
  });

  it('prefers a nickname set on the pair, if one ever is', () => {
    expect(toPairListing(row({ displayName: "Kush's iPhone" })).displayName).toBe("Kush's iPhone");
  });

  it('stays null when the phone enrolled without a name, so the UI can fall back', () => {
    expect(toPairListing(row({ deviceName: null })).displayName).toBeNull();
  });

  it('keeps two phones distinguishable, which is the whole point', () => {
    const ios = toPairListing(row({ pairId: 'p1', deviceName: 'ios phone' }));
    const android = toPairListing(row({ pairId: 'p2', deviceName: 'android phone' }));
    expect(ios.displayName).not.toBe(android.displayName);
  });
});

describe('what a listing must never leak', () => {
  // 2026-07-19 audit: the full self-asserted id must not be readable by any
  // caller that merely knows a desktop id.
  it('masks the fingerprint down to a short suffix', () => {
    const listing = toPairListing(row());
    expect(listing.mobileFingerprint).toBe('…utlmuu');
    expect(listing.mobileFingerprint).not.toContain('kqmqmoiq');
  });

  it('leaves a fingerprint too short to mask alone rather than padding it', () => {
    expect(toPairListing(row({ mobileFingerprint: 'abc' })).mobileFingerprint).toBe('abc');
  });
});

describe('the rest of the row', () => {
  it('reports revoked from the timestamp, not a separate flag', () => {
    expect(toPairListing(row()).revoked).toBe(false);
    expect(toPairListing(row({ revokedAt: new Date() })).revoked).toBe(true);
  });

  it('sends timestamps as ISO strings, and null when never connected', () => {
    expect(toPairListing(row()).lastConnectedAt).toBeNull();
    const connected = toPairListing(row({ lastConnectedAt: new Date('2026-08-21T20:59:05.879Z') }));
    expect(connected.lastConnectedAt).toBe('2026-08-21T20:59:05.879Z');
    expect(connected.createdAt).toBe('2026-08-21T20:57:35.524Z');
  });
});

/**
 * The phone's half of the same relationship. It exists because the phone's
 * keychain list was checked against nothing: a laptop revoked from the other
 * side, or belonging to a deleted account, kept appearing until the user
 * tapped it and the connect failed.
 */
describe('a pair as the phone sees it', () => {
  const mobileRow = (over: Partial<MobilePairListingRow> = {}): MobilePairListingRow => ({
    pairId: 'pair-1',
    desktopDeviceId: 'desktop-e0660317-559c-49ad-b8b2-6d0b85a7b329',
    name: 'macos desktop',
    displayName: null,
    revokedAt: null,
    lastConnectedAt: null,
    createdAt: new Date('2026-08-21T20:57:35.524Z'),
    ...over,
  });

  /**
   * NOT masked, unlike the mobile fingerprint the desktop list returns. The
   * caller has proved with a device token that it is one side of this pair,
   * and a phone that cannot match ids against its keychain cannot reconcile —
   * which is the whole purpose of the route.
   */
  it('returns the full desktop id, because the phone has to match it', () => {
    const listing = toMobilePairListing(mobileRow());
    expect(listing.desktopDeviceId).toBe('desktop-e0660317-559c-49ad-b8b2-6d0b85a7b329');
    expect(listing.desktopDeviceId).not.toContain('…');
  });

  it('reports a revoked pair as revoked rather than hiding it', () => {
    // Hiding it would leave the phone unable to tell "revoked" from "the
    // backend forgot about this", and those have different remedies.
    expect(toMobilePairListing(mobileRow({ revokedAt: new Date() })).revoked).toBe(true);
    expect(toMobilePairListing(mobileRow()).revoked).toBe(false);
  });

  it("uses the laptop's own name, and lets a pair nickname win", () => {
    expect(toMobilePairListing(mobileRow()).name).toBe('macos desktop');
    expect(toMobilePairListing(mobileRow({ displayName: 'Work Mac' })).name).toBe('Work Mac');
    expect(toMobilePairListing(mobileRow({ name: null })).name).toBeNull();
  });

  it('agrees with the desktop list about precedence, so the two never disagree', () => {
    const nickname = 'Work Mac';
    const desktopSide = toPairListing(row({ displayName: nickname }));
    const phoneSide = toMobilePairListing(mobileRow({ displayName: nickname }));
    expect(phoneSide.name).toBe(desktopSide.displayName);
  });

  it('sends timestamps as ISO strings', () => {
    expect(toMobilePairListing(mobileRow()).lastConnectedAt).toBeNull();
    const seen = toMobilePairListing(
      mobileRow({ lastConnectedAt: new Date('2026-08-21T20:59:05.879Z') }),
    );
    expect(seen.lastConnectedAt).toBe('2026-08-21T20:59:05.879Z');
    expect(seen.createdAt).toBe('2026-08-21T20:57:35.524Z');
  });
});

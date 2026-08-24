// This app's `types` allowlist is `["react-native", "jest"]`, and adding
// `@types/node` to it for one file would put node's globals — its timer types
// above all — in front of React Native's across the whole app. Jest runs on
// node, so these two exist at runtime; declaring them is cheaper and narrower
// than the dependency.
// `export {}` matters: without it this file is a script, not a module, and the
// two declarations below would land in the global scope and collide with every
// other test file's own `require`.
export {};

declare const __dirname: string;
declare const require: (m: 'fs') => {
  readFileSync(path: string, encoding: 'utf8'): string;
  readFileSync(path: string): {
    length: number;
    readUInt32BE(o: number): number;
    toString(e: 'ascii', s: number, en: number): string;
  };
  existsSync(path: string): boolean;
};

/**
 * iOS bundle declarations that decide runtime behaviour and appear in no other
 * test, because nothing in the JavaScript imports them.
 */

const plist = require('fs').readFileSync(
  `${__dirname}/../../../ios/LilypadMobile/Info.plist`,
  'utf8',
);

const privacyManifest = require('fs').readFileSync(
  `${__dirname}/../../../ios/LilypadMobile/PrivacyInfo.xcprivacy`,
  'utf8',
);

const stringFor = (key: string): string | null =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? null;

describe('iOS Info.plist', () => {
  it('explains why it wants the local network', () => {
    // iOS 14 introduced local network privacy (Apple, TN3179), and the LAN path
    // is the product's first and best route. Apple: "Any app that uses the local
    // network, directly or indirectly, should include this description … as well
    // as direct unicast … connections to local hosts." Reaching a Mac by the
    // address it advertised is exactly that.
    expect((stringFor('NSLocalNetworkUsageDescription') ?? '').length).toBeGreaterThan(20);
  });

  it('explains why it wants the camera', () => {
    expect((stringFor('NSCameraUsageDescription') ?? '').length).toBeGreaterThan(20);
  });

  it('keeps App Transport Security on, with only the local-networking exception', () => {
    // `NSAllowsArbitraryLoads` would turn HTTPS enforcement off for the whole
    // app to solve a problem that `NSAllowsLocalNetworking` solves for the one
    // case that has it.
    expect(plist).toMatch(/<key>NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
  });
});

/**
 * What App Store Connect refuses, or stalls on, at upload time.
 *
 * These are not runtime behaviour — they are the difference between a build
 * that reaches a tester and one that sits waiting for a human to answer a form.
 * Nothing in the app imports them, so nothing else would notice them going
 * missing.
 */
describe('what the App Store requires before a build can be tested', () => {
  it('answers the export-compliance question in the bundle, not by hand each time', () => {
    // Absent this key, EVERY TestFlight upload stops and asks. `false` is the
    // accurate answer for this app: HTTPS to the control plane, DTLS-SRTP for
    // media — both provided by the platform and by WebRTC — and Ed25519 for
    // device identity, which authenticates rather than conceals. No
    // proprietary or non-standard cryptography is implemented here.
    expect(plist).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  });

  it('ships a privacy manifest, which submission has required since 2024', () => {
    // The two keys Apple validates: whether the app tracks, and the reasons it
    // gives for each required-reason API it calls. An empty or absent manifest
    // is an upload rejection, not a warning.
    expect(privacyManifest).toMatch(/NSPrivacyTracking/);
    expect(privacyManifest).toMatch(/NSPrivacyAccessedAPITypes/);
  });

  /**
   * `NSPrivacyCollectedDataTypes` was an empty array, which declares that this
   * app causes nothing to be stored about anyone. `users.email` is NOT NULL —
   * the account IS an email address — and the published privacy policy says so
   * in as many words. A manifest that contradicts the policy is the half that
   * is wrong, and it is the half Apple reads.
   *
   * Checked against the backend schema, not against intent.
   */
  it('declares the data the backend schema proves it collects', () => {
    for (const type of [
      // users.email, NOT NULL.
      'NSPrivacyCollectedDataTypeEmailAddress',
      // users.name, supplied at signup.
      'NSPrivacyCollectedDataTypeName',
      // devices.fingerprint and devices.name.
      'NSPrivacyCollectedDataTypeDeviceID',
      // audit_logs.ip, kept 2 days for abuse and account security.
      'NSPrivacyCollectedDataTypeOtherDataTypes',
    ]) {
      expect(privacyManifest).toContain(type);
    }
    expect(privacyManifest).not.toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
  });

  it('claims no tracking anywhere, which is what "no analytics SDK" has to mean', () => {
    // One `NSPrivacyTracking` plus one `NSPrivacyCollectedDataTypeTracking`
    // per declared type. A single `<true/>` among them would be an app that
    // tracks, and there is no advertising or analytics SDK in this bundle.
    expect(privacyManifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    expect(privacyManifest).not.toMatch(
      /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<true\/>/,
    );
  });
});

describe('the app icon', () => {
  // The asset catalogue held a Contents.json and no images at all, so the app
  // had no icon: blank on the home screen, and rejected by App Store Connect,
  // which requires the 1024 marketing icon before a build can be processed.
  // Nothing else in this repo reads these files, so nothing else would notice
  // them going missing again.
  const iconDir = `${__dirname}/../../../ios/LilypadMobile/Images.xcassets/AppIcon.appiconset`;

  it('exists at the one size App Store Connect will not process a build without', () => {
    expect(require('fs').existsSync(`${iconDir}/AppIcon.png`)).toBe(true);
  });

  it('is listed in the catalogue, not merely present on disk', () => {
    // A PNG that Contents.json does not name is a file Xcode ignores.
    const contents = require('fs').readFileSync(`${iconDir}/Contents.json`, 'utf8');
    expect(JSON.parse(contents).images).toEqual([
      expect.objectContaining({ filename: 'AppIcon.png', size: '1024x1024' }),
    ]);
  });

  it('is 1024x1024 with no alpha channel', () => {
    // Apple rejects an icon with alpha. Read the PNG's IHDR directly rather
    // than adding an image library: bytes 16..24 are width and height, byte 25
    // is the colour type, where 6 is RGBA and 4 is greyscale+alpha.
    const png = require('fs').readFileSync(`${iconDir}/AppIcon.png`) as unknown as {
      readUInt32BE(o: number): number;
      toString(e: 'ascii', s: number, en: number): string;
      [i: number]: number;
    };
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    const colourType = png[25];
    expect([4, 6]).not.toContain(colourType);
  });
});

/**
 * The signing identity baked into the Xcode project.
 *
 * These two strings decide which Apple account the app belongs to, and nothing
 * else in the repo reads them — the Appfile and Fastfile only carry them as
 * fallbacks, and CI passes secrets that override both. So a project edited to
 * a different team, or a bundle id that drifts from the registered App ID,
 * fails nowhere until an archive is rejected minutes into a TestFlight run.
 *
 * Written after an App Store Connect key was supplied for team AR2Q4Y465L
 * while the project still built for 7TYFS43RR3: a build signed by one team
 * cannot be notarized or uploaded with another team's key. The project now
 * targets AR2Q4Y465L, the team that owns the App ID and the key.
 */
describe('the Apple account this app is signed for', () => {
  const pbxproj = require('fs').readFileSync(
    `${__dirname}/../../../ios/LilypadMobile.xcodeproj/project.pbxproj`,
    'utf8',
  );

  const settings = (key: string): string[] => {
    const found = new Set<string>();
    for (const m of pbxproj.matchAll(new RegExp(`${key} = ([^;\\s]+);`, 'g'))) {
      const value = m[1];
      if (value) found.add(value);
    }
    return [...found].sort();
  };

  it('builds for exactly one team', () => {
    expect(settings('DEVELOPMENT_TEAM')).toEqual(['AR2Q4Y465L']);
  });

  it('uses the bundle id the App ID is registered under', () => {
    // The test target is a separate bundle id and is never uploaded.
    expect(settings('PRODUCT_BUNDLE_IDENTIFIER')).toEqual([
      'com.takedia.lilypad',
      'com.takedia.lilypad.tests',
    ]);
  });
});

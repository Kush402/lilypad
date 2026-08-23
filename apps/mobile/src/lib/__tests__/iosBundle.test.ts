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
declare const require: (m: 'fs') => { readFileSync(path: string, encoding: 'utf8'): string };

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

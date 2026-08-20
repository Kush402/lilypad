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

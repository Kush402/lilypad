import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The three bundle settings that are load-bearing at runtime and invisible in
 * every other test: nothing here is imported by the app, so a regression would
 * ship silently and only show up on a customer's machine.
 */

const root = join(__dirname, '..', '..');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const plist = readFileSync(join(root, 'src-tauri', 'Info.plist'), 'utf8');

describe('macOS bundle', () => {
  it('explains why it wants the local network, because macOS 15 gates the LAN path', () => {
    // Apple, TN3179: local network privacy arrived on macOS in macOS 15, and an
    // ICE host candidate to a phone on the same Wi-Fi is both of the operations
    // it lists as requiring access ("Making an outgoing TCP connection: yes",
    // "Sending a UDP unicast: yes"). Without this key the alert still appears —
    // with no reason attached, on the prompt that decides whether "nothing
    // leaves your home" is true for that user.
    const match = /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>([^<]+)<\/string>/.exec(
      plist,
    );
    expect(match?.[1]?.length ?? 0).toBeGreaterThan(20);
  });

  it('does not overwrite the version Tauri generates', () => {
    // The merge happens at bundle time and the CLI's own values lose. Apple's
    // version keys are the ones that break the updater if they drift.
    expect(plist).not.toMatch(/CFBundleShortVersionString|CFBundleVersion/);
  });
});

describe('webview security', () => {
  it('keeps a Content-Security-Policy', () => {
    // `csp: null` shipped for two milestones. The frontend renders no remote
    // content and React escapes, so there was no live injection path — but the
    // window it sits in can invoke every Tauri command, which makes "no known
    // vector today" a thin thing to rely on.
    const csp: unknown = conf.app?.security?.csp;
    expect(typeof csp).toBe('string');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    // The QR code is an <img src="data:image/png;base64,…">, so this one is
    // required rather than incidental — dropping it blanks the pairing screen.
    expect(csp).toContain('data:');
  });

  it('does not expose the Tauri IPC handle as a global', () => {
    // Every call site imports from `@tauri-apps/api`, so the global was reach
    // for any script that ever ran in the window and convenience for nobody.
    expect(conf.app?.withGlobalTauri).toBe(false);
  });
});

describe('the icons Tauri turns into the .icns', () => {
  /**
   * `tauri build` builds the macOS .icns from exactly the files in
   * `bundle.icon`, mapping each one's pixel size to an ICNS type. A size with
   * no type aborts the bundle:
   *
   *     failed to bundle project: Failed to create app icon: `No matching IconType`
   *
   * It names no file, and it happens AFTER the four-minute release build, so
   * the cost of getting this wrong is a whole failed release. It was got wrong:
   * regenerating the icons produced a 1024x1024 `icon.png`, and ICNS has no
   * 1024-at-1x type — 1024 exists only as 512@2x.
   */
  const ICNS_1X = [16, 32, 48, 64, 128, 256, 512];
  const ICNS_2X = [16, 32, 64, 128, 256, 512];

  const pngSize = (rel: string): { w: number; h: number } => {
    const png = readFileSync(join(root, 'src-tauri', rel));
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
  };

  it('lists icons at all', () => {
    expect(Array.isArray(conf.bundle?.icon)).toBe(true);
    expect(conf.bundle.icon.length).toBeGreaterThan(0);
  });

  it.each(
    (
      JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).bundle
        .icon as string[]
    ).map((f) => [f] as [string]),
  )('%s is square and a size ICNS has a type for', (file) => {
    const { w, h } = pngSize(file);
    expect(w, `${file} is not square`).toBe(h);
    // `@2x` in the name is how the bundler infers density.
    const allowed = file.includes('@2x') ? ICNS_2X.map((n) => n * 2) : ICNS_1X;
    expect(
      allowed,
      `${file} is ${w}x${h}; allowed for this density: ${allowed.join(', ')}`,
    ).toContain(w);
  });
});

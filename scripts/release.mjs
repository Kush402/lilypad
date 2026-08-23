#!/usr/bin/env node
/**
 * `pnpm release <version|major|minor|patch>` — bump the desktop app version in
 * lockstep across the three files that must agree (or the updater's version
 * comparison and the build both misbehave):
 *
 *   - apps/desktop/src-tauri/tauri.conf.json   ("version")
 *   - apps/desktop/src-tauri/Cargo.toml        (package `version`)
 *   - apps/desktop/package.json                ("version")
 *
 * ...and the mobile app alongside them, which it did not until 2026-08-22:
 *
 *   - apps/mobile/package.json                 ("version")
 *   - apps/mobile/src/config/version.ts        (APP_VERSION — what the phone
 *                                               reports to the backend)
 *   - apps/mobile/ios/.../project.pbxproj      (MARKETING_VERSION, both configs)
 *   - apps/mobile/android/app/build.gradle     (versionName)
 *
 * Leaving those out was not cosmetic. Every iOS build ever installed reported
 * itself as `1.0`, so two phones running different code were indistinguishable
 * — including to the person trying to work out why one of them is broken.
 *
 * It only rewrites files; it never tags or pushes. It prints the exact
 * `git tag && git push --tags` commands so cutting a release stays a
 * deliberate, visible act (the `Release` workflow triggers on the `v*` tag).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const TAURI_CONF = join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json');
const CARGO_TOML = join(repoRoot, 'apps/desktop/src-tauri/Cargo.toml');
const PKG_JSON = join(repoRoot, 'apps/desktop/package.json');
const MOBILE_PKG_JSON = join(repoRoot, 'apps/mobile/package.json');
const MOBILE_VERSION_TS = join(repoRoot, 'apps/mobile/src/config/version.ts');
const SITE_INDEX = join(repoRoot, 'apps/site/index.html');
const IOS_PBXPROJ = join(repoRoot, 'apps/mobile/ios/LilypadMobile.xcodeproj/project.pbxproj');
const ANDROID_GRADLE = join(repoRoot, 'apps/mobile/android/app/build.gradle');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function die(msg) {
  console.error(`\x1b[31mrelease: ${msg}\x1b[0m`);
  process.exit(1);
}

/** Read the current version from tauri.conf.json (the source of truth). */
function currentVersion() {
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
  if (!conf.version || !SEMVER.test(conf.version)) {
    die(`could not read a valid semver "version" from ${TAURI_CONF}`);
  }
  return conf.version;
}

/** Resolve the requested next version from an explicit semver or a bump kind. */
function nextVersion(current, arg) {
  if (SEMVER.test(arg)) return arg;
  const [, maj, min, pat] = current.match(SEMVER).map(Number);
  switch (arg) {
    case 'major':
      return `${maj + 1}.0.0`;
    case 'minor':
      return `${maj}.${min + 1}.0`;
    case 'patch':
      return `${maj}.${min}.${pat + 1}`;
    default:
      die(`expected a semver (e.g. 0.2.0) or one of major|minor|patch, got "${arg}"`);
  }
}

/** Replace `from` with `to` in `file`, asserting it occurred exactly `times`.
 * The assertion is the point: a file that has drifted out of lockstep fails
 * the release rather than being silently skipped. */
function replaceExactly(file, from, to, label, times = 1) {
  const before = readFileSync(file, 'utf8');
  const found = before.split(from).length - 1;
  if (found !== times) {
    die(`${label}: expected \`${from}\` ${times}x in ${file}, found ${found}`);
  }
  writeFileSync(file, before.split(from).join(to));
}

/** The single-occurrence case, which is most of them. */
function replaceOnce(file, from, to, label) {
  replaceExactly(file, from, to, label, 1);
}

function main() {
  const arg = process.argv[2];
  if (!arg) die('usage: pnpm release <version|major|minor|patch>');

  const current = currentVersion();
  const next = nextVersion(current, arg);
  if (next === current) die(`version is already ${current}`);

  // tauri.conf.json + package.json share the same JSON shape for the field.
  replaceOnce(TAURI_CONF, `"version": "${current}"`, `"version": "${next}"`, 'tauri.conf.json');
  replaceOnce(PKG_JSON, `"version": "${current}"`, `"version": "${next}"`, 'package.json');
  // Cargo's package version is the only bare `version = "x.y.z"` line (deps use
  // ranges like ">=0.9, <0.10"), so this exact string is unambiguous.
  replaceOnce(CARGO_TOML, `version = "${current}"`, `version = "${next}"`, 'Cargo.toml');

  // The phone. `MARKETING_VERSION` appears once per build configuration
  // (Debug and Release); both must move or the two builds disagree about
  // what they are.
  replaceOnce(
    MOBILE_PKG_JSON,
    `"version": "${current}"`,
    `"version": "${next}"`,
    'mobile package.json',
  );
  replaceOnce(
    MOBILE_VERSION_TS,
    `APP_VERSION = '${current}'`,
    `APP_VERSION = '${next}'`,
    'mobile version.ts',
  );
  replaceExactly(
    IOS_PBXPROJ,
    `MARKETING_VERSION = ${current};`,
    `MARKETING_VERSION = ${next};`,
    'iOS project.pbxproj',
    2,
  );
  console.log(`\x1b[32m✓ bumped ${current} → ${next}\x1b[0m in:`);
  replaceOnce(
    ANDROID_GRADLE,
    `versionName "${current}"`,
    `versionName "${next}"`,
    'android build.gradle',
  );

  // The website advertises the version a visitor is about to download, in two
  // places: the hero line and the download button. `apps/site/src/claims.test.ts`
  // reads the shipped version out of tauri.conf.json and asserts the page names
  // it — which is what caught this: cutting v0.1.5 turned the site build red
  // because the page still said v0.1.4. The page once advertised v0.1.1 for
  // forty-two commits, so the guard stays and the bump comes here.
  replaceExactly(SITE_INDEX, `v${current}`, `v${next}`, 'site index.html', 2);

  // Cargo.lock records the workspace member's own version, and bumping
  // Cargo.toml without it leaves the two disagreeing. They did: at tag v0.1.4
  // Cargo.toml said 0.1.4 and the committed Cargo.lock still said 0.1.3, so
  // every tagged commit carried a lockfile one release behind — repaired only
  // afterwards, by whoever next ran cargo. Nothing failed, because no build
  // passes `--locked`; a build that did would refuse the release tag, and a
  // "reproducible from the tag" claim would be false.
  //
  // `--workspace --offline` touches only the local package (5s, no network,
  // no dependency resolution), so this cannot quietly move a dependency as a
  // side effect of cutting a release.
  try {
    execFileSync('cargo', ['update', '--workspace', '--offline'], {
      cwd: dirname(CARGO_TOML),
      stdio: 'pipe',
    });
    console.log('  apps/desktop/src-tauri/Cargo.lock');
  } catch (err) {
    die(
      `Cargo.toml was bumped but Cargo.lock could not be updated: ${err.message}\n` +
        `Run \`cargo update --workspace --offline\` in apps/desktop/src-tauri before committing.`,
    );
  }


  console.log('  apps/desktop/src-tauri/tauri.conf.json');
  console.log('  apps/desktop/src-tauri/Cargo.toml');
  console.log('  apps/desktop/package.json');
  console.log('  apps/mobile/package.json');
  console.log('  apps/mobile/src/config/version.ts');
  console.log('  apps/mobile/ios/LilypadMobile.xcodeproj/project.pbxproj');
  console.log('  apps/mobile/android/app/build.gradle');
  console.log('  apps/site/index.html');
  console.log('\nNext:');
  console.log(`  git commit -am "chore(release): v${next}"`);
  console.log(`  git tag v${next} && git push && git push --tags`);
  console.log('\nPushing the tag triggers .github/workflows/release.yml.');
}

main();

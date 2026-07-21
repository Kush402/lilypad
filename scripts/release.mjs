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
 * It only rewrites files; it never tags or pushes. It prints the exact
 * `git tag && git push --tags` commands so cutting a release stays a
 * deliberate, visible act (the `Release` workflow triggers on the `v*` tag).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const TAURI_CONF = join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json');
const CARGO_TOML = join(repoRoot, 'apps/desktop/src-tauri/Cargo.toml');
const PKG_JSON = join(repoRoot, 'apps/desktop/package.json');

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

/** Replace exactly `from` with `to` in `file`, asserting it occurred once. */
function replaceOnce(file, from, to, label) {
  const before = readFileSync(file, 'utf8');
  const parts = before.split(from);
  if (parts.length === 1) die(`${label}: could not find \`${from}\` in ${file}`);
  if (parts.length > 2)
    die(`${label}: \`${from}\` is ambiguous (found ${parts.length - 1}x) in ${file}`);
  writeFileSync(file, parts.join(to));
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

  console.log(`\x1b[32m✓ bumped ${current} → ${next}\x1b[0m in:`);
  console.log('  apps/desktop/src-tauri/tauri.conf.json');
  console.log('  apps/desktop/src-tauri/Cargo.toml');
  console.log('  apps/desktop/package.json');
  console.log('\nNext:');
  console.log(`  git commit -am "chore(release): v${next}"`);
  console.log(`  git tag v${next} && git push && git push --tags`);
  console.log('\nPushing the tag triggers .github/workflows/release.yml.');
}

main();

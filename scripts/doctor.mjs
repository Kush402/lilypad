#!/usr/bin/env node
/**
 * `pnpm env:check` — inspect the dev environment and report every prerequisite as
 * OK / MISSING / BROKEN with exact repair instructions. Dependency-free (Node
 * builtins only) so it runs before `pnpm install` has a chance to fail.
 *
 * Exit code: non-zero if any REQUIRED check is BROKEN, so CI/bootstrap can gate.
 *
 * NOT named `doctor`. `pnpm doctor` is one of pnpm's own commands, so a script
 * by that name is shadowed: `pnpm doctor` ran pnpm's built-in, printed a config
 * warning and exited 0, while every document in the repo told people that was
 * how to check their machine. A diagnostic that silently diagnoses nothing is
 * worse than none. `env:check` also matches the repo's other gates —
 * `docs:check`, `workflows:check`, `apple:check`, `rust:check`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const IS_MAC = platform() === 'darwin';
const OK = 'ok';
const WARN = 'warn';
const BROKEN = 'broken';

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m',
};
const MARK = { [OK]: `${C.green}✅${C.reset}`, [WARN]: `${C.yellow}⚠️ ${C.reset}`, [BROKEN]: `${C.red}❌${C.reset}` };

/** Locate an executable on PATH (no shell → unaffected by aliases/hooks). */
export function which(cmd) {
  const finder = platform() === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0];
  return null;
}

/** Run a command, capturing stdout; returns null on failure. */
function out(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Cargo may be installed but not on PATH — the exact bug this repo hit. */
export function resolveCargo() {
  const onPath = which('cargo');
  if (onPath) return { path: onPath, onPath: true };
  const fallback = join(HOME, '.cargo', 'bin', 'cargo');
  if (existsSync(fallback)) return { path: fallback, onPath: false };
  return { path: null, onPath: false };
}

/** Does any zsh startup file source rustup's env? (zsh ignores ~/.profile.) */
export function zshSourcesCargo() {
  for (const f of ['.zshenv', '.zprofile', '.zshrc']) {
    const p = join(HOME, f);
    if (existsSync(p) && /cargo\/env|\.cargo\/bin/.test(readFileSync(p, 'utf8'))) return f;
  }
  return null;
}

function dockerContainer(name) {
  const s = out('docker', ['ps', '--filter', `name=${name}`, '--format', '{{.Status}}']);
  return s || null;
}

/** Each check returns { name, status, detail, fix?, required }. */
export function runChecks() {
  const checks = [];
  const add = (name, status, detail, fix, required = false) =>
    checks.push({ name, status, detail, fix, required });

  // ── Node ──
  const node = out('node', ['--version']);
  if (node) {
    const major = Number(node.replace(/^v/, '').split('.')[0]);
    add('Node.js', major >= 20 ? OK : WARN, node, major >= 20 ? null : 'Need Node >= 20 (nvm install 20)', true);
  } else add('Node.js', BROKEN, 'not found', 'Install Node 20+ (https://nodejs.org or nvm)', true);

  // ── pnpm ──
  const pnpm = out('pnpm', ['--version']);
  add('pnpm', pnpm ? OK : BROKEN, pnpm || 'not found', pnpm ? null : 'corepack enable && corepack prepare pnpm@10 --activate', true);

  // ── Rust toolchain (the startup blocker) ──
  const cargo = resolveCargo();
  const rustcVer = cargo.path ? out(cargo.path.replace(/cargo$/, 'rustc'), ['--version']) : null;
  if (!cargo.path) {
    add('Rust (cargo)', BROKEN, 'not installed', 'Install: curl https://sh.rustup.rs -sSf | sh', true);
  } else if (!cargo.onPath) {
    const sourced = zshSourcesCargo();
    // If a zsh startup file already sources cargo, the fix is applied and only
    // a shell restart is pending — non-blocking. If nothing sources it, the
    // toolchain is genuinely unreachable — blocking.
    add(
      'Rust (cargo)',
      sourced ? WARN : BROKEN,
      `installed at ${cargo.path} but not on THIS shell's PATH (${rustcVer || 'toolchain present'})`,
      sourced
        ? `Fix is applied in ~/${sourced} — open a NEW terminal (or run: source ~/.cargo/env) so cargo is visible.`
        : `rustup wrote its PATH to ~/.profile, which zsh ignores. Run \`pnpm bootstrap\` (auto-fixes), or: echo '[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"' >> ~/.zshenv then restart your shell.`,
      true,
    );
  } else {
    add('Rust (cargo)', OK, `${out('cargo', ['--version'])} · ${rustcVer || ''}`.trim(), null, true);
  }

  // ── Tauri CLI (desktop) — resolved from the workspace ──
  const tauri = out('pnpm', ['--filter', '@lilypad/desktop', 'exec', 'tauri', '--version']);
  add('Tauri CLI', tauri ? OK : WARN, tauri || 'not resolvable', tauri ? null : 'Run `pnpm install` first (it is a devDependency)', false);

  // ── Docker + infra containers ──
  const docker = out('docker', ['--version']);
  if (!docker) {
    add('Docker', BROKEN, 'not found', 'Install Docker Desktop and start it', true);
  } else {
    add('Docker', OK, docker, null, true);
    for (const svc of ['lilypad-postgres', 'lilypad-redis', 'lilypad-coturn']) {
      const status = dockerContainer(svc);
      const label = svc.replace('lilypad-', '');
      add(`  infra:${label}`, status ? OK : WARN, status || 'not running', status ? null : 'pnpm infra:up', false);
    }
    // Known gotcha: a brew-installed Redis on 6379 shadows the compose one.
    if (IS_MAC && out('redis-cli', ['-h', '127.0.0.1', '-p', '6379', 'ping']) === 'PONG' && !dockerContainer('lilypad-redis')) {
      add('  redis:host-shadow', WARN, 'a non-Docker Redis answers on 6379', 'Stop it (brew services stop redis) so the compose Redis is used', false);
    }
  }

  // ── macOS native tooling (mobile / capture) ──
  if (IS_MAC) {
    const clt = out('xcode-select', ['-p']);
    add('Xcode CLT', clt ? OK : BROKEN, clt || 'not installed', clt ? null : 'xcode-select --install', true);
    const fullXcode = clt && clt.includes('Xcode.app');
    add('Xcode (full, for iOS)', fullXcode ? OK : WARN, fullXcode ? clt : 'CLT only — cannot build iOS', 'Install Xcode.app from the App Store, then: sudo xcode-select -s /Applications/Xcode.app', false);
    const pod = out('pod', ['--version']);
    add('CocoaPods (iOS)', pod ? OK : WARN, pod || 'not installed', 'sudo gem install cocoapods', false);
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    add('Android SDK', androidHome ? OK : WARN, androidHome || 'ANDROID_HOME unset', 'Install Android Studio + SDK, export ANDROID_HOME', false);
  }

  return checks;
}

function report(checks) {
  console.log('\nLilypad environment doctor\n' + '─'.repeat(30));
  for (const c of checks) {
    const fix = c.status !== OK && c.fix ? `\n      ${C.dim}↳ ${c.fix}${C.reset}` : '';
    console.log(`${MARK[c.status]} ${c.name.padEnd(22)} ${C.dim}${c.detail}${C.reset}${fix}`);
  }
  const broken = checks.filter((c) => c.status === BROKEN && c.required);
  const warns = checks.filter((c) => c.status === WARN);
  console.log('─'.repeat(30));
  if (broken.length) {
    console.log(`${C.red}${broken.length} blocking issue(s) — fix these before launching.${C.reset}`);
  } else {
    console.log(`${C.green}All required prerequisites satisfied.${C.reset}` + (warns.length ? ` ${C.yellow}(${warns.length} optional item(s) missing — mobile/native only.)${C.reset}` : ''));
  }
  return broken.length === 0;
}

// Run when invoked directly (not when imported by bootstrap).
if (import.meta.url === `file://${process.argv[1]}`) {
  const okAll = report(runChecks());
  process.exit(okAll ? 0 : 1);
}

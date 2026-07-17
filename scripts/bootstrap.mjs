#!/usr/bin/env node
/**
 * `pnpm bootstrap` — one command to prepare a clean machine for Lilypad.
 * Self-heals the most common blocker (rustup PATH not visible to zsh), installs
 * dependencies, starts infra, runs migrations, and verifies the workspace.
 * Fails with human-readable diagnostics; never requires manual debugging for
 * anything software can detect and repair.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCargo, zshSourcesCargo, which } from './doctor.mjs';

const HOME = homedir();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', bold: '\x1b[1m', dim: '\x1b[2m' };

let step = 0;
const log = (m) => console.log(`\n${C.bold}[${++step}] ${m}${C.reset}`);
const ok = (m) => console.log(`  ${C.green}✓${C.reset} ${m}`);
const warn = (m) => console.log(`  ${C.yellow}⚠${C.reset} ${m}`);
const fail = (m) => {
  console.error(`\n${C.red}✗ bootstrap failed:${C.reset} ${m}\n`);
  process.exit(1);
};

/** Run a command inheriting stdio; fail the bootstrap on non-zero exit. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) fail(`\`${cmd} ${args.join(' ')}\` exited ${r.status ?? '(signal)'}`);
}
function tryOut(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
  return r.status === 0 ? r.stdout.trim() : null;
}

console.log(`${C.bold}Lilypad bootstrap${C.reset}`);

// ── 1. Node + pnpm (already running under them, but verify versions) ──
log('Verifying Node & pnpm');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) fail(`Node ${process.versions.node} is too old — need >= 20`);
ok(`Node ${process.versions.node}`);
const pnpmV = tryOut('pnpm', ['--version']);
if (!pnpmV) fail('pnpm not found — run: corepack enable && corepack prepare pnpm@10 --activate');
ok(`pnpm ${pnpmV}`);

// ── 2. Rust toolchain + PATH self-heal ──
log('Verifying Rust toolchain (and healing the zsh PATH if needed)');
const cargo = resolveCargo();
if (!cargo.path) {
  fail('Rust is not installed. Install it, then re-run:\n    curl https://sh.rustup.rs -sSf | sh');
}
if (!cargo.onPath) {
  // The toolchain exists but zsh can't see it. rustup writes its PATH line to
  // ~/.profile, which zsh does not source. Append the source to ~/.zshenv
  // (sourced by every zsh invocation) — idempotently.
  const zshenv = join(HOME, '.zshenv');
  const already = zshSourcesCargo();
  if (!already) {
    appendFileSync(
      zshenv,
      '\n# Added by Lilypad bootstrap: make the rustup toolchain visible to zsh\n' +
        '# (rustup writes to ~/.profile, which zsh does not source).\n' +
        '[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"\n',
    );
    ok(`patched ~/.zshenv to source ~/.cargo/env (cargo was installed but invisible to zsh)`);
  } else {
    warn(`~/.${already} references cargo but this shell's PATH still lacks it`);
  }
  warn('cargo is not on THIS shell\'s PATH yet — open a new terminal, or run: source ~/.cargo/env');
} else {
  ok(`cargo on PATH (${tryOut('cargo', ['--version'])})`);
}
// Use the resolved absolute cargo for the rest of bootstrap regardless of PATH.
const CARGO = cargo.path;

// ── 3. Install workspace dependencies ──
log('Installing workspace dependencies (pnpm install)');
run('pnpm', ['install']);
ok('dependencies installed');

// ── 4. Docker + infra ──
log('Starting infra (Postgres, Redis, coturn)');
if (!which('docker')) {
  warn('Docker not found — skipping infra. Install Docker Desktop, then: pnpm infra:up');
} else {
  run('pnpm', ['infra:up']);
  // Wait for Postgres to accept connections before migrating.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    if (tryOut('docker', ['exec', 'lilypad-postgres-1', 'pg_isready', '-U', 'lilypad']) !== null) {
      ready = true;
      break;
    }
    spawnSync('sleep', ['1']);
  }
  ready ? ok('Postgres is accepting connections') : warn('Postgres did not report ready in 30s — check `docker ps`');

  // ── 5. Migrations ──
  log('Running database migrations');
  run('pnpm', ['--filter', '@lilypad/backend', 'db:migrate']);
  ok('migrations applied');
}

// ── 6. Verify the workspace builds ──
log('Verifying the workspace');
run('pnpm', ['turbo', 'typecheck']);
ok('TypeScript typecheck passed');
const meta = spawnSync(CARGO, ['metadata', '--no-deps', '--format-version', '1'], {
  cwd: join(ROOT, 'apps/desktop/src-tauri'),
  encoding: 'utf8',
});
if (meta.status !== 0) fail(`\`cargo metadata\` failed — the desktop crate cannot be resolved:\n${meta.stderr}`);
ok('cargo metadata OK (desktop crate resolves — Tauri can build)');

// ── Done ──
console.log(`\n${C.green}${C.bold}✓ Bootstrap complete.${C.reset}`);
console.log(`\n${C.bold}Launch:${C.reset}`);
console.log('  Backend :  pnpm --filter @lilypad/backend dev');
console.log('  Desktop :  pnpm --filter @lilypad/desktop tauri dev');
console.log('  Mobile  :  cd apps/mobile && pnpm pods && pnpm ios   (needs full Xcode)');
if (!cargo.onPath) {
  console.log(`\n${C.yellow}NOTE:${C.reset} cargo is not on this shell's PATH yet, but the desktop launch`);
  console.log('      (`pnpm --filter @lilypad/desktop tauri dev`) self-heals PATH and works anyway.');
  console.log('      For bare `cargo` commands, open a NEW terminal or run: source ~/.cargo/env');
  console.log('      Verify anytime with: pnpm doctor');
}

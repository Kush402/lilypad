#!/usr/bin/env node
/**
 * Wrapper that runs the Tauri CLI with the rustup toolchain guaranteed on PATH.
 *
 * Why: the Tauri CLI shells out to `cargo metadata`. On macOS, rustup writes its
 * PATH line to ~/.profile, which zsh does not source — so `cargo` is installed
 * but invisible, and `tauri dev` dies with `failed to run 'cargo metadata'`.
 * Rather than depend on the user's shell profile being correct (and on them
 * having restarted their terminal), this prepends ~/.cargo/bin to PATH for the
 * Tauri process and its children. Works in any shell, no restart, cross-platform.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

const isWin = process.platform === 'win32';
const cargoBin = join(homedir(), '.cargo', 'bin');
const cargoExe = join(cargoBin, isWin ? 'cargo.exe' : 'cargo');

const env = { ...process.env };
if (existsSync(cargoExe)) {
  const parts = (env.PATH || '').split(delimiter);
  if (!parts.includes(cargoBin)) {
    env.PATH = cargoBin + delimiter + (env.PATH || '');
  }
} else {
  console.error(
    '\x1b[31mcargo not found at ' + cargoExe + '.\x1b[0m\n' +
      'Install the Rust toolchain, then retry:\n' +
      "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\n" +
      'Diagnose anytime with: pnpm doctor',
  );
  process.exit(1);
}

// The `tauri` binary is on PATH via node_modules/.bin when invoked through pnpm.
const child = spawn('tauri', process.argv.slice(2), { stdio: 'inherit', env, shell: isWin });
child.on('error', (err) => {
  console.error('failed to launch the Tauri CLI:', err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

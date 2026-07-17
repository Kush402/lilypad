#!/usr/bin/env node
/**
 * `pnpm clean[:scope]` — reclaim disk from generated build artifacts only.
 *
 * Every path removed is on a hardcoded allowlist of KNOWN-generated, git-ignored
 * directories. Source code, config, docs, migrations, lockfiles, and .env are
 * never touched. Cross-platform (Node fs, no `rm -rf`).
 *
 * Scopes:
 *   build   TS/JS build output + Rust example/release/incremental artifacts.
 *           Keeps target/debug/deps (the heavy dep cache) so rebuilds stay fast.
 *   cargo   The entire Rust target/ (full `cargo clean`). Big reclaim; next
 *           build recompiles the whole dependency tree (~minutes).
 *   mobile  Android/iOS build outputs, Gradle project cache, Pods, Metro cache.
 *   deps    node_modules (root + per-package). Requires `pnpm install` after.
 *   (none)  build + mobile — the safe default: frees space without forcing a
 *           full Rust recompile or a reinstall.
 *   all     cargo + mobile + deps + build (nuclear; full rebuild + reinstall).
 */
import { rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Allowlist of generated paths, grouped by scope. Relative to repo root.
const GROUPS = {
  build: [
    'apps/desktop/src-tauri/target/release',
    'apps/desktop/src-tauri/target/debug/examples',
    'apps/desktop/src-tauri/target/debug/incremental',
    'apps/desktop/src-tauri/target/tmp',
    'apps/backend/dist',
    'apps/desktop/dist',
    'apps/admin/dist',
    'packages/protocol/dist',
    'packages/shared/dist',
    '.turbo',
    'apps/desktop/node_modules/.vite',
  ],
  cargo: ['apps/desktop/src-tauri/target'],
  mobile: [
    'apps/mobile/android/app/build',
    'apps/mobile/android/build',
    'apps/mobile/android/.gradle',
    'apps/mobile/ios/build',
    'apps/mobile/ios/Pods',
    'apps/mobile/node_modules/.cache',
  ],
  deps: [
    'node_modules',
    'apps/backend/node_modules',
    'apps/desktop/node_modules',
    'apps/admin/node_modules',
    'apps/mobile/node_modules',
    'packages/protocol/node_modules',
    'packages/shared/node_modules',
  ],
};
GROUPS.default = [...GROUPS.build, ...GROUPS.mobile];
GROUPS.all = [...GROUPS.cargo, ...GROUPS.mobile, ...GROUPS.deps, ...GROUPS.build];

// Also clean any stray *.tsbuildinfo (generated incremental TS state).
function tsbuildinfos() {
  try {
    return execSync('find . -name "*.tsbuildinfo" -not -path "*/node_modules/*"', { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      for (const e of readdirSync(cur)) stack.push(join(cur, e));
    } else {
      total += st.size;
    }
  }
  return total;
}
const human = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB');

const scope = (process.argv[2] || 'default').replace(/^clean:?/, '') || 'default';
if (!GROUPS[scope]) {
  console.error(`Unknown scope "${scope}". Use one of: ${Object.keys(GROUPS).filter((s) => s !== 'default').join(', ')}, or no arg for the safe default.`);
  process.exit(1);
}

let paths = GROUPS[scope].map((p) => join(ROOT, p));
if (scope === 'build' || scope === 'default' || scope === 'all') paths.push(...tsbuildinfos().map((p) => resolve(ROOT, p)));

// Hard safety: every path must resolve INSIDE the repo root.
paths = paths.filter((p) => p.startsWith(ROOT + '/') && p !== ROOT);

console.log(`\ncleaning scope: ${scope}\n` + '─'.repeat(40));
let reclaimed = 0;
for (const p of paths) {
  if (!existsSync(p)) continue;
  const size = dirSize(p);
  rmSync(p, { recursive: true, force: true });
  reclaimed += size;
  console.log(`  removed ${p.replace(ROOT + '/', '').padEnd(48)} ${human(size)}`);
}
console.log('─'.repeat(40));
console.log(`reclaimed: ${human(reclaimed)}`);
if (scope === 'cargo' || scope === 'all') console.log('note: next `cargo build`/`tauri dev` will recompile the full dependency tree.');
if (scope === 'deps' || scope === 'all') console.log('note: run `pnpm install` before developing again.');
if (scope === 'mobile' || scope === 'all') console.log('note: run `pnpm --filter @lilypad/mobile pods` (iOS) before the next mobile build.');

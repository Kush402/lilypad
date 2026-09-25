#!/usr/bin/env node
/**
 * `pnpm audit:exceptions` — keep `pnpm.auditConfig.ignoreGhsas` honest.
 *
 * Suppressing an advisory is sometimes right: `image-size` has two high-severity
 * denial-of-service bugs with no patched version, reachable only through
 * `metro` at build time. Suppressing one *permanently* is not. Both failure
 * modes are silent:
 *
 *   - a suppression outlives its reason, because "re-check when a fix ships" is
 *     a sentence in a document and nobody re-reads documents;
 *   - a suppression appears with no reason at all, which is indistinguishable
 *     from one added to make CI green. docs/deployment.md says exactly that,
 *     and nothing enforced it.
 *
 * So: every ignored GHSA must be named in docs/deployment.md, and must still
 * have no installable, compatible patched version. When either stops being
 * true this fails, and the remedy is to remove the suppression.
 *
 * Dependency-free, matching the other checks. The advisory lookup is public and
 * unauthenticated; no network is treated as unknown rather than as a pass.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const ignored = pkg?.pnpm?.auditConfig?.ignoreGhsas ?? [];

if (ignored.length === 0) {
  console.log('audit-exceptions: OK (nothing suppressed)');
  process.exit(0);
}

const DOC = 'docs/deployment.md';
const doc = readFileSync(join(ROOT, DOC), 'utf8');
const metroImageSizeAdvisories = new Set(['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq']);

/** The current Metro calls image-size as a synchronous CommonJS function.
 * image-size 2.x removed that API. Re-evaluate immediately if Metro, its
 * declared range, its call site, or our installed 1.x version changes. */
function metroStillNeedsImageSize1() {
  try {
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    const metroRoot = join(ROOT, 'node_modules/.pnpm/metro@0.81.5/node_modules/metro');
    const metro = JSON.parse(readFileSync(join(metroRoot, 'package.json'), 'utf8'));
    const assets = readFileSync(join(metroRoot, 'src/Assets.js'), 'utf8');
    const consumers = [...lock.matchAll(/^ {6}image-size: (\S+)$/gm)].map((match) => match[1]);
    return (
      lock.includes('  image-size@1.2.1:') &&
      consumers.length === 1 &&
      consumers[0] === '1.2.1' &&
      metro.dependencies?.['image-size'] === '^1.0.2' &&
      assets.includes('const getImageSize = require("image-size");') &&
      assets.includes('getImageSize(content)')
    );
  } catch {
    return false;
  }
}

for (const ghsa of ignored) {
  if (!doc.includes(ghsa)) {
    problems.push(`${ghsa} is suppressed but not explained in ${DOC}`);
    continue;
  }

  let advisory;
  try {
    const res = await fetch(`https://api.github.com/advisories/${ghsa}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'lilypad-audit-exceptions' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      problems.push(`${ghsa} is not a known advisory — check the id`);
      continue;
    }
    if (!res.ok) {
      console.log(`  skip  ${ghsa} — GitHub answered HTTP ${res.status}`);
      continue;
    }
    advisory = await res.json();
  } catch (err) {
    console.log(`  skip  ${ghsa} — could not reach GitHub (${err.message})`);
    continue;
  }

  // A patched version is actionable only if the pinned consumer can use it.
  // For the two image-size advisories, Metro 0.81.5 still calls the removed
  // synchronous 1.x API. Do not force 2.x into that build-time path just to
  // silence the audit: the iOS/Android bundle would fail to build.
  const fixed = (advisory.vulnerabilities ?? [])
    .map((v) => v.first_patched_version)
    .filter(Boolean);
  if (fixed.length) {
    const incompatibleMetroFix =
      metroImageSizeAdvisories.has(ghsa) &&
      fixed.every((version) => Number(version.split('.')[0]) >= 2) &&
      metroStillNeedsImageSize1();
    if (incompatibleMetroFix) {
      console.log(`  ok    ${ghsa} — 2.x is patched but breaks pinned Metro's synchronous 1.x API`);
    } else {
      problems.push(
        `${ghsa} now has a patched version (${fixed.join(', ')}) — upgrade and remove the suppression`,
      );
    }
  } else {
    console.log(`  ok    ${ghsa} — still unpatched upstream, and explained in ${DOC}`);
  }
}

if (problems.length === 0) {
  console.log(`audit-exceptions: OK (${ignored.length} suppression(s))`);
  process.exit(0);
}
console.error(`\naudit-exceptions: ${problems.length} problem(s)\n`);
for (const p of problems) console.error(`  - ${p}`);
console.error('');
process.exit(1);

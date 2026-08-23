#!/usr/bin/env node
/**
 * `pnpm workflows:check` — every GitHub Actions workflow parses and has jobs.
 *
 * Written after shipping a workflow whose YAML did not parse. It happened
 * inside a `run:` block scalar: a continuation line starting at column 0 ends
 * the block, and the result is a file that looks fine in a diff, passes
 * `prettier --check` — Prettier reformats YAML it can read and says nothing
 * about YAML it cannot map to a workflow — and is rejected by GitHub.
 *
 * The reason that matters more than a red build: the file it happened to was
 * `watchdog.yml`. A scheduled workflow with invalid YAML does not fail. It
 * simply never runs again, and the only signal is the absence of one. All
 * production monitoring would have stopped, silently, on a green push.
 *
 * Deliberately shallow. This is not a linter for what a workflow DOES — it
 * answers "will GitHub load this file at all", which is the question that had
 * no answer before a push.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const dir = join(process.cwd(), '.github/workflows');
const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

if (files.length === 0) {
  console.error('workflows-check: no workflows found — is this the repo root?');
  process.exit(1);
}

let failed = 0;
for (const file of files.sort()) {
  let doc;
  try {
    doc = parse(readFileSync(join(dir, file), 'utf8'));
  } catch (err) {
    console.error(`  FAIL ${file}: ${String(err.message).split('\n')[0]}`);
    failed += 1;
    continue;
  }
  // `on` is the one key YAML 1.1 parsers famously turn into the boolean true.
  // The `yaml` package is 1.2 and keeps it a string, which is what GitHub
  // reads — so checking for either spelling here would hide a real problem.
  const triggers = doc?.on;
  const jobs = doc?.jobs;
  if (!triggers) {
    console.error(`  FAIL ${file}: parses, but declares no triggers`);
    failed += 1;
    continue;
  }
  if (!jobs || Object.keys(jobs).length === 0) {
    console.error(`  FAIL ${file}: parses, but declares no jobs`);
    failed += 1;
    continue;
  }
  console.log(`  ok   ${file} (${Object.keys(jobs).length} job(s))`);
}

console.log(
  failed === 0
    ? `workflows-check: OK (${files.length} workflows)`
    : `workflows-check: ${failed} of ${files.length} invalid`,
);
process.exit(failed === 0 ? 0 : 1);

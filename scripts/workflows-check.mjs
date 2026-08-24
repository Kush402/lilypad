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
 *
 * It grew one more question of the same kind. A reusable workflow gets only the
 * permissions its CALLER grants, and asking for more is not a job failure: the
 * run is refused before any job starts, reported as `startup_failure` with zero
 * jobs, zero logs and zero annotations. Adding `checks: write` to a job in
 * `ci.yml` broke every `deploy.yml` run that way, and the only visible evidence
 * was a red dot with nothing behind it.
 */
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const dir = join(process.cwd(), '.github/workflows');
const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

if (files.length === 0) {
  console.error('workflows-check: no workflows found — is this the repo root?');
  process.exit(1);
}

let failed = 0;
/** file -> { job -> {perm: level} } for every job that declares permissions. */
const declared = new Map();
/** callers: { file, job, uses, granted } for every `uses: ./.github/workflows/...` */
const callers = [];
/** file -> [{ job, step, run, shell }] for every step that runs shell. */
const runBlocks = new Map();

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
  // Record what each job asks for, and who calls whom, for the caller/callee
  // permission comparison below.
  const perms = {};
  for (const [name, job] of Object.entries(jobs)) {
    if (job && typeof job === 'object' && job.permissions && typeof job.permissions === 'object') {
      perms[name] = job.permissions;
    }
    const uses = job?.uses;
    if (typeof uses === 'string' && uses.startsWith('./.github/workflows/')) {
      callers.push({
        file,
        job: name,
        uses: uses.replace('./.github/workflows/', ''),
        granted: (job.permissions && typeof job.permissions === 'object') ? job.permissions : {},
      });
    }
  }
  declared.set(file, perms);

  const blocks = [];
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run === 'string') {
        blocks.push({
          job: name,
          step: step.name ?? step.run.split('\n')[0].slice(0, 40),
          run: step.run,
          shell: step.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell,
        });
      }
    }
  }
  runBlocks.set(file, blocks);

  console.log(`  ok   ${file} (${Object.keys(jobs).length} job(s))`);
}

// Every `run:` block must be valid shell. A syntax error there is not caught by
// YAML parsing — the file loads, the job starts, and it dies partway through
// after the runner has already spent minutes on checkout, node, pnpm and cargo.
//
// `${{ ... }}` is substituted by GitHub before bash ever sees it and is not
// valid shell, so it is replaced with a harmless token first. Steps that name a
// non-bash shell are skipped rather than guessed at.
const EXPR = /\$\{\{[^}]*\}\}/g;
for (const [file, blocks] of runBlocks) {
  for (const { job, step, run, shell } of blocks) {
    if (shell && !/^bash|^sh$/.test(shell)) continue;
    const dir = mkdtempSync(join(tmpdir(), 'wfcheck-'));
    const path = join(dir, 'step.sh');
    writeFileSync(path, run.replace(EXPR, 'GH_EXPR'));
    const res = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    if (res.status !== 0) {
      console.error(
        `  FAIL ${file}: job "${job}", step "${step}" is not valid shell:\n` +
          `        ${String(res.stderr).trim().split('\n').join('\n        ')}`,
      );
      failed += 1;
    }
  }
}

// A caller must grant at least what every job in the called workflow declares.
// `write` satisfies a `read` request; nothing satisfies a missing key.
const RANK = { none: 0, read: 1, write: 2 };
for (const { file, job, uses, granted } of callers) {
  const callee = declared.get(uses);
  if (!callee) {
    console.error(`  FAIL ${file}: job "${job}" calls ${uses}, which is not a workflow here`);
    failed += 1;
    continue;
  }
  for (const [calleeJob, wanted] of Object.entries(callee)) {
    for (const [perm, level] of Object.entries(wanted)) {
      const have = granted[perm];
      if (RANK[have] === undefined || RANK[have] < RANK[level]) {
        console.error(
          `  FAIL ${file}: job "${job}" calls ${uses}, whose job "${calleeJob}" needs ` +
            `${perm}: ${level}, but the caller grants ${have ? `${perm}: ${have}` : 'nothing'}. ` +
            `GitHub refuses the whole run with startup_failure and no logs.`,
        );
        failed += 1;
      }
    }
  }
}

console.log(
  failed === 0
    ? `workflows-check: OK (${files.length} workflows)`
    : `workflows-check: ${failed} of ${files.length} invalid`,
);
process.exit(failed === 0 ? 0 : 1);

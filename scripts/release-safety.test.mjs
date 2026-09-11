import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
const steps = workflow.jobs.release.steps;
const preflight = steps.find((step) => step.id === 'preflight');
const required = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'APPLE_CERTIFICATE',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_TEAM_ID',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_KEY_P8',
];

// What publishes is a PUSHED version tag. The trigger has to be varied
// independently of the ref: `gh workflow run release.yml --ref v0.1.34` gives a
// `workflow_dispatch` a `refs/tags/v0.1.34` ref, and a rule that read only the
// ref shape published from it. The third row below is that case.
const triggers = [
  { ref: 'refs/tags/v0.1.29', event: 'push', publishes: true },
  { ref: 'refs/heads/main', event: 'workflow_dispatch', publishes: false },
  { ref: 'refs/tags/v0.1.29', event: 'workflow_dispatch', publishes: false },
  { ref: 'refs/heads/main', event: 'push', publishes: false },
];

// Execute only the local export/presence check, with dummy values and an
// isolated environment. Never call Apple or load the developer's credentials.
for (const { ref, event, publishes: tagPush } of triggers) {
  for (const missing of [null, ...required]) {
    const rejects = missing && (tagPush || missing === 'TAURI_SIGNING_PRIVATE_KEY');
    test(`${event} on ${ref} release preflight ${missing ? `handles missing ${missing}` : 'accepts complete inputs'}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'lilypad-release-preflight-'));
      try {
        const env = Object.fromEntries(required.map((key) => [key, 'test-only']));
        if (missing) delete env[missing];
        const result = spawnSync('/bin/bash', ['-c', preflight.run], {
          encoding: 'utf8',
          env: {
            ...env,
            GITHUB_REF: ref,
            GITHUB_EVENT_NAME: event,
            GITHUB_ENV: join(dir, 'env'),
            GITHUB_OUTPUT: join(dir, 'output'),
          },
        });
        assert.equal(result.status, rejects ? 1 : 0, result.stdout + result.stderr);
        if (missing) assert.match(result.stdout, new RegExp(missing));
        if (!rejects) {
          const output = readFileSync(join(dir, 'output'), 'utf8');
          // A manual dispatch builds and signs a candidate and leaves it a
          // draft, however complete its inputs are and whatever ref it was
          // pointed at.
          assert.match(output, !missing && tagPush ? /publish=true/ : /publish=false/);
          if (!missing) {
            assert.match(output, /signing=true/);
            assert.match(output, /notarize=true/);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('every release target is chosen by the trigger, not by the ref it was pointed at', () => {
  // `github.ref_type == 'tag'` is true for a dispatch pointed at a tag, so a
  // workflow that reads it targets that tag's EXISTING release — the upload
  // guard is then the only thing standing between a manual build and a public
  // release's assets. A dispatch gets its own run-scoped draft instead.
  const raw = readFileSync('.github/workflows/release.yml', 'utf8');
  assert.equal(
    raw.includes('github.ref_type'),
    false,
    'the release target must not be chosen by the ref type',
  );
  const expressions = [...raw.matchAll(/\$\{\{[^\n]*v0\.0\.0-dispatch[^\n]*\}\}/g)].map(
    (match) => match[0],
  );
  assert.ok(expressions.length >= 4, 'expected every tag expression to name the dispatch fallback');
  assert.equal(
    new Set(expressions).size,
    1,
    'every step must compute the same release tag: ' + [...new Set(expressions)].join(' | '),
  );
  assert.match(expressions[0], /github\.event_name == 'push'/);
  assert.match(expressions[0], /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

test('release artifacts stay draft until notarization and Gatekeeper checks finish', () => {
  const target = steps.findIndex((step) => step.id === 'release_target');
  const build = steps.findIndex((step) => step.uses?.startsWith('tauri-apps/tauri-action@'));
  const gatekeeper = steps.findIndex(
    (step) => step.name === 'Verify Gatekeeper will actually accept it',
  );
  const publish = steps.findIndex((step) => step.name === 'Publish the verified release');
  assert.ok(target >= 0 && build === target + 1 && gatekeeper > build && publish > gatekeeper);
  assert.equal(
    steps[target].if,
    undefined,
    'every upload checks its target, including manual runs',
  );
  assert.equal(steps[target].env.TAG, steps[build].with.tagName);
  assert.equal(steps[target].env.TAG, steps[publish].env.TAG);
  assert.equal(steps[build].with.releaseDraft, true);
  assert.equal(
    steps[publish].if,
    "steps.preflight.outputs.publish == 'true'",
    'publication requires complete signing inputs and ordinary successful prior steps',
  );
  assert.match(steps[publish].run, /gh release edit .*--draft=false/);
  assert.match(steps[gatekeeper].run, /spctl --assess/);
  assert.match(steps[gatekeeper].run, /stapler validate "\$dmg"/);
  assert.equal(publish, steps.length - 1);
});

const targetGate = steps.find((step) => step.id === 'release_target');
const targetTag = 'v0.1.29';
const matchingDraft = { tag_name: targetTag, draft: true };
const matchingPublic = { tag_name: targetTag, draft: false };
for (const [label, pages, error] of [
  ['no existing releases', [[]], null],
  ['an existing draft', [[matchingDraft]], null],
  ['an unrelated public release', [[{ tag_name: 'v0.1.28', draft: false }]], null],
  ['a draft on a later page', [[{ tag_name: 'v0.1.28', draft: false }], [matchingDraft]], null],
  ['a public same-tag release', [[matchingPublic]], /already public/],
  ['a public prerelease', [[{ ...matchingPublic, prerelease: true }]], /already public/],
  [
    'a public release on a later page',
    [[matchingDraft], [matchingPublic]],
    /ambiguous release tag/,
  ],
  [
    'a same-tag public release after an unrelated page',
    [[{ tag_name: 'v0.1.28', draft: true }], [matchingPublic]],
    /already public/,
  ],
  ['missing draft state', [[{ tag_name: targetTag }]], /invalid release publication state/],
  [
    'a string draft state',
    [[{ tag_name: targetTag, draft: 'true' }]],
    /invalid release publication state/,
  ],
  [
    'a malformed unrelated entry',
    [[matchingDraft, { draft: false }]],
    /invalid release publication state/,
  ],
  ['an API error object', { message: 'Bad credentials' }, /invalid release-list response/],
  ['an empty page envelope', [], /invalid release-list response/],
  ['a non-array page', [matchingDraft], /invalid release-list response/],
  ['a null entry', [[null]], /invalid release publication state/],
]) {
  test(`release upload gate ${error ? 'rejects' : 'accepts'} ${label}`, () => {
    const result = runTargetGate(JSON.stringify(pages));
    assert.equal(result.status, error ? 1 : 0, result.stdout + result.stderr);
    if (error) assert.match(result.stderr, error);
  });
}

for (const [label, fixture, status, error] of [
  ['authentication failure', '{"message":"Bad credentials"}', 1, /could not verify/],
  ['repository not found', '{"message":"Not Found"}', 1, /could not verify/],
  ['network failure', '', 1, /could not verify/],
  ['a partial pagination failure', JSON.stringify([[matchingDraft]]), 1, /could not verify/],
  ['malformed JSON', '{', 0, /invalid release-list response/],
  ['empty output', '', 0, /invalid release-list response/],
]) {
  test(`release upload gate fails closed on ${label}`, () => {
    const result = runTargetGate(fixture, status);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, error);
  });
}

test('release upload gate checks the manual dispatch tag exactly', () => {
  const tag = 'v0.0.0-dispatch.42';
  const result = runTargetGate(JSON.stringify([[{ tag_name: tag, draft: false }]]), 0, tag);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release v0\.0\.0-dispatch\.42 is already public/);
});

function runTargetGate(fixture, status = 0, tag = targetTag) {
  // The stub permits exactly one read-only, fully paginated API request. It
  // never calls GitHub and returns only the fixture supplied by this test.
  const stub = `gh() {
    printf 'GH_CALL:%s\\n' "$*" >&2
    [ "$*" = "api --method GET --paginate --slurp repos/test/repo/releases?per_page=100" ] || return 99
    printf '%s\\n' "$RELEASE_FIXTURE"
    return "$GH_STATUS"
  }\n`;
  const result = spawnSync('/bin/bash', ['-c', stub + targetGate.run], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: 'test/repo',
      TAG: tag,
      RELEASE_FIXTURE: fixture,
      GH_STATUS: String(status),
    },
  });
  assert.deepEqual(
    result.stderr.split('\n').filter((line) => line.startsWith('GH_CALL:')),
    ['GH_CALL:api --method GET --paginate --slurp repos/test/repo/releases?per_page=100'],
  );
  return result;
}

const siteWorkflow = parse(readFileSync('.github/workflows/site.yml', 'utf8'));
const stage = siteWorkflow.jobs['build-and-deploy'].steps.find(
  (step) => step.name === 'Stage the installer the site hands out',
);
// Exercise the actual staging gate with an authenticated-release response,
// stopping before any downloads or filesystem changes. `gh` is a shell stub;
// the JSON validation and version lookup are the workflow's real commands.
const stagingGate = stage.run.slice(0, stage.run.indexOf('mkdir -p apps/site/dist/download'));
const version = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8')).version;
for (const [label, release, expectedStatus] of [
  ['published stable release', { tagName: `v${version}`, isDraft: false, isPrerelease: false }, 0],
  ['draft release', { tagName: `v${version}`, isDraft: true, isPrerelease: false }, 1],
  ['prerelease', { tagName: `v${version}`, isDraft: false, isPrerelease: true }, 1],
  ['different version', { tagName: 'v0.0.0', isDraft: false, isPrerelease: false }, 1],
  ['missing publication state', { tagName: `v${version}` }, 1],
]) {
  test(`site distribution gate ${expectedStatus ? 'rejects' : 'accepts'} ${label}`, () => {
    assert.ok(stagingGate.length > 0 && !stagingGate.includes('gh release download'));
    const result = spawnSync(
      '/bin/bash',
      ['-c', 'gh() { printf "%s\\n" "$RELEASE_FIXTURE"; }\n' + stagingGate],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, RELEASE_FIXTURE: JSON.stringify(release) },
      },
    );
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    if (expectedStatus) assert.match(result.stderr, /requires the published stable release/);
  });
}

// --- mobile iOS: the lane's own pod-install guard ---------------------------
//
// fastlane runs a LANE BODY with the working directory set to the `fastlane/`
// folder and only its ACTIONS one level up, in the project folder. A guard
// written against bare `Pods/Manifest.lock` therefore names a path that cannot
// exist, is always false, and re-runs the `pod install` that loses to
// CocoaPods #12798/#12866 at roughly one run in two. That is what took
// mobile-v0.1.31 down: the workflow's own step reported the sandbox already
// current, the lane installed anyway, and the build never reached TestFlight.
//
// The guard is lifted from the shipped Fastfile and evaluated the way fastlane
// evaluates it, so this cannot pass on a Fastfile that has drifted back.
const fastfile = readFileSync('apps/mobile/ios/fastlane/Fastfile', 'utf8');
const podGuard = fastfile.slice(
  fastfile.indexOf('    pods_match_lockfile = '),
  fastfile.indexOf('    if pods_match_lockfile'),
);
// `codegen` is the third input, and the one that made the first version of
// this fix a worse bug than the one it fixed: `pod install` also writes React
// Native's generated sources under `ios/build/generated`, which `Pods.xcodeproj`
// references and git ignores. A guard that skipped on `Manifest.lock` alone
// would hand the archive a Pods tree whose generated sources do not exist.
for (const [label, manifest, codegen, expected] of [
  ['a sandbox that already matches Podfile.lock', 'LOCK', true, 'true'],
  ['a sandbox built from a different lockfile', 'STALE', true, 'false'],
  ['no sandbox at all', null, false, 'false'],
  ['a Pods tree restored without its generated sources', 'LOCK', false, 'false'],
]) {
  test(`the iOS beta lane detects ${label}`, () => {
    assert.ok(podGuard.includes('Dir.chdir'), 'the pod guard was not found in the Fastfile');
    const dir = mkdtempSync(join(tmpdir(), 'lilypad-pod-guard-'));
    try {
      mkdirSync(join(dir, 'fastlane'));
      writeFileSync(join(dir, 'Podfile.lock'), 'LOCK');
      if (manifest !== null) {
        mkdirSync(join(dir, 'Pods'));
        writeFileSync(join(dir, 'Pods', 'Manifest.lock'), manifest);
      }
      if (codegen) {
        mkdirSync(join(dir, 'build', 'generated', 'ios'), { recursive: true });
        writeFileSync(join(dir, 'build', 'generated', 'ios', 'ReactCodegen.podspec.json'), '{}');
      }
      const result = spawnSync('ruby', ['-e', `${podGuard}\nputs pods_match_lockfile`], {
        cwd: join(dir, 'fastlane'),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.equal(result.stdout.trim(), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The workflow asks the same question in bash before the lane asks it in Ruby.
// They drifted once already (the workflow skipped, the lane installed anyway),
// and that drift cost mobile-v0.1.31 — so the two conditions are checked
// against the same fixtures, from the shipped workflow, not a copy of it.
const iosWorkflow = parse(readFileSync('.github/workflows/mobile-ios.yml', 'utf8'));
const iosSteps = iosWorkflow.jobs.ios.steps;
const podCache = iosSteps.find((step) => step.name === 'Cache the CocoaPods sandbox');
const podInstall = iosSteps.find((step) => step.name === 'Install CocoaPods');

test('the pod cache carries the generated sources, under a key that can still be written', () => {
  const paths = String(podCache.with.path)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(paths.includes('apps/mobile/ios/Pods'), paths.join(','));
  assert.ok(paths.includes('apps/mobile/ios/build/generated'), paths.join(','));
  // A cache entry is immutable: widening `path` under the old key would restore
  // the old half-contents forever and never save the new ones.
  assert.ok(!podCache.with.key.startsWith('pods-$'), podCache.with.key);
});

for (const [label, manifest, codegen, skips] of [
  ['a sandbox that already matches Podfile.lock', 'LOCK', true, true],
  ['a sandbox built from a different lockfile', 'STALE', true, false],
  ['no sandbox at all', null, false, false],
  ['a Pods tree restored without its generated sources', 'LOCK', false, false],
]) {
  test(`the iOS workflow ${skips ? 'skips' : 'installs'} for ${label}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'lilypad-pod-step-'));
    try {
      writeFileSync(join(dir, 'Podfile.lock'), 'LOCK');
      if (manifest !== null) {
        mkdirSync(join(dir, 'Pods'));
        writeFileSync(join(dir, 'Pods', 'Manifest.lock'), manifest);
      }
      if (codegen) {
        mkdirSync(join(dir, 'build', 'generated', 'ios'), { recursive: true });
        writeFileSync(join(dir, 'build', 'generated', 'ios', 'ReactCodegen.podspec.json'), '{}');
      }
      // Stop before the retry loop: running `pod install` here is neither
      // possible nor the thing under test.
      const gate = podInstall.run.slice(0, podInstall.run.indexOf('for attempt in'));
      const result = spawnSync('/bin/bash', ['-c', gate], { cwd: dir, encoding: 'utf8' });
      assert.equal(/skipping install/.test(result.stdout), skips, result.stdout + result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

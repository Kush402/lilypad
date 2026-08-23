#!/usr/bin/env node
/**
 * `pnpm apple:check` — validate Apple signing material BEFORE a release needs it.
 *
 * Every value in `release.yml` and `mobile-ios.yml` is a base64 blob or an
 * opaque id pasted into a GitHub secret. When one is wrong the failure arrives
 * twenty minutes into a build, as a message from `codesign`, `notarytool` or
 * fastlane about something else — and the fix is another twenty-minute round
 * trip. This checks each one in about a second, against the same rules the
 * workflows apply.
 *
 * Reads from the environment so it can be run two ways:
 *
 *   - locally, before pasting:  APPLE_CERTIFICATE=$(base64 -i cert.p12) … pnpm apple:check
 *   - in CI, after the secrets exist, as a preflight that names what is wrong.
 *
 * It never prints a secret. Only lengths, fingerprints and parsed identities.
 *
 * Dependency-free, matching doctor.mjs / docs-check.mjs house style. `security`
 * and `openssl` are macOS built-ins; the p12 check is skipped elsewhere with a
 * line saying so rather than silently passing.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let problems = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, remedy) => {
  problems += 1;
  console.log(`  FAIL  ${m}`);
  if (remedy) console.log(`        ${remedy}`);
};
const skip = (m) => console.log(`  skip  ${m}`);

/** Present and non-blank. An unset GitHub secret interpolates to "", which is
 * why blank is treated as absent everywhere in this repo. */
const val = (name) => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
};

function decodeBase64(name, expectSubstring) {
  const raw = val(name);
  if (!raw) return null;
  let decoded;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    bad(`${name} is not valid base64`, 'Re-run: base64 -i <file> | pbcopy');
    return null;
  }
  // base64 of a text file round-trips; base64 of raw text does not decode to
  // anything containing the marker, which is the usual paste mistake.
  if (expectSubstring && !decoded.toString('utf8').includes(expectSubstring)) {
    bad(
      `${name} decoded to ${decoded.length} bytes that do not contain "${expectSubstring}"`,
      'It must be the FILE, base64-encoded — not the file’s text, and not the base64 of the base64.',
    );
    return null;
  }
  ok(`${name} decodes to ${decoded.length} bytes`);
  return decoded;
}

console.log('\nApple signing preflight\n');

// ── Team id ────────────────────────────────────────────────────────────────
const team = val('APPLE_TEAM_ID');
if (!team) bad('APPLE_TEAM_ID is not set', 'Apple Developer → Membership details → Team ID.');
else if (!/^[A-Z0-9]{10}$/.test(team))
  bad(`APPLE_TEAM_ID is ${JSON.stringify(team)}`, 'A Team ID is 10 upper-case alphanumerics.');
else ok(`APPLE_TEAM_ID ${team}`);

// ── Developer ID certificate (desktop: Gatekeeper + stable TCC identity) ───
const p12 = decodeBase64('APPLE_CERTIFICATE', null);
const identity = val('APPLE_SIGNING_IDENTITY');
if (!p12) {
  bad(
    'APPLE_CERTIFICATE is not set — the desktop build will be AD-HOC signed',
    'Keychain Access → your Developer ID Application cert → Export as .p12, then base64 -i it.',
  );
} else if (process.platform !== 'darwin') {
  skip('cannot verify the .p12 off macOS (needs `security`)');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'lilypad-apple-'));
  const file = join(dir, 'cert.p12');
  writeFileSync(file, p12);
  try {
    // `-noout` so nothing sensitive is printed; the friendlyName line names
    // the identity the workflow must be told to sign with.
    const out = execFileSync(
      'openssl',
      ['pkcs12', '-in', file, '-nokeys', '-passin', `pass:${process.env.APPLE_CERTIFICATE_PASSWORD ?? ''}`, '-legacy'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const cn = /subject=.*?CN\s*=\s*([^,\n/]+)/.exec(out)?.[1]?.trim();
    if (!cn) bad('the .p12 parsed but names no certificate subject');
    else {
      ok(`APPLE_CERTIFICATE contains "${cn}"`);
      if (!/^Developer ID Application:/.test(cn)) {
        bad(
          `that is not a Developer ID Application certificate`,
          'An "Apple Development" or "Apple Distribution" cert cannot sign for distribution outside the App Store. Create a Developer ID Application certificate.',
        );
      }
      if (identity && identity !== cn) {
        bad(
          `APPLE_SIGNING_IDENTITY does not match the certificate`,
          `The certificate is "${cn}". codesign matches this string exactly.`,
        );
      } else if (identity) {
        ok('APPLE_SIGNING_IDENTITY matches the certificate');
      } else {
        bad('APPLE_SIGNING_IDENTITY is not set', `Set it to "${cn}".`);
      }
      if (team && !cn.includes(`(${team})`)) {
        bad(
          'the certificate does not belong to APPLE_TEAM_ID',
          `The certificate names a different team than ${team}.`,
        );
      }
    }
  } catch (err) {
    bad(
      'the .p12 could not be opened',
      'Usually APPLE_CERTIFICATE_PASSWORD is wrong, or the export was cancelled and the file is empty.',
    );
    void err;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* the temp dir goes with the process */
    }
  }
}

// ── App Store Connect API key (notarization AND TestFlight) ───────────────
// `decodeBase64` has already reported anything it could not parse. Reporting
// "is not set" on top of "did not decode" is two messages for one problem, and
// a diagnostic that repeats itself gets skimmed.
if (!val('APPLE_API_KEY_P8')) {
  bad(
    'APPLE_API_KEY_P8 is not set — notarization will be skipped',
    'App Store Connect → Users and Access → Integrations → App Store Connect API → generate a key with the Developer role. The .p8 downloads once and cannot be downloaded again.',
  );
} else {
  decodeBase64('APPLE_API_KEY_P8', 'BEGIN PRIVATE KEY');
}
for (const [name, shape, what] of [
  ['APPLE_API_KEY', /^[A-Z0-9]{8,12}$/, 'the Key ID shown next to the key'],
  ['APPLE_API_ISSUER', /^[0-9a-f-]{36}$/i, 'the Issuer ID at the top of the same page (a UUID)'],
]) {
  const v = val(name);
  if (!v) bad(`${name} is not set`, `It is ${what}.`);
  else if (!shape.test(v)) bad(`${name} is ${JSON.stringify(v)}`, `Expected ${what}.`);
  else ok(`${name} ${v}`);
}

// ── The same key, under the names the iOS lane reads ──────────────────────
// `release.yml` (desktop notarization) and `mobile-ios.yml` (TestFlight) can
// use ONE App Store Connect key, but they read it under different names. A key
// that works for one and is missing for the other is the likeliest way to have
// half a release pipeline.
console.log('\niOS TestFlight lane reads the same key under different names:\n');
if (!val('ASC_KEY_P8')) bad('ASC_KEY_P8 is not set', 'Same .p8 as APPLE_API_KEY_P8, base64-encoded.');
else decodeBase64('ASC_KEY_P8', 'BEGIN PRIVATE KEY');
for (const [name, mirror] of [
  ['ASC_KEY_ID', 'APPLE_API_KEY'],
  ['ASC_ISSUER_ID', 'APPLE_API_ISSUER'],
]) {
  const v = val(name);
  if (!v) bad(`${name} is not set`, `Same value as ${mirror}.`);
  else if (val(mirror) && v !== val(mirror))
    bad(`${name} and ${mirror} disagree`, 'They are the same key; one of them is a typo.');
  else ok(`${name} ${v}`);
}

console.log(
  problems === 0
    ? '\nAll Apple signing inputs look right.\n'
    : `\n${problems} problem(s). Nothing was uploaded or changed.\n`,
);
process.exit(problems === 0 ? 0 : 1);

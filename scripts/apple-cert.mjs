#!/usr/bin/env node
/**
 * `pnpm apple:cert <path-to.cer>` — take the certificate Apple issues and turn
 * it into the three GitHub secrets `release.yml` needs.
 *
 * The manual version of this is six Keychain Access steps, and the one that
 * silently goes wrong is the pairing: a `.cer` whose private key is not in this
 * keychain imports happily, exports nothing usable, and fails months later
 * inside `codesign`. This checks that first and refuses to continue.
 *
 * Nothing here is a secret except the .p12 password, which is generated rather
 * than chosen so it never gets reused from somewhere else. It is printed once
 * and set as a secret in the same run.
 *
 * Dependency-free, matching the other scripts. macOS only — `security` is the
 * whole point.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const die = (msg, remedy) => {
  console.error(`\n  ${msg}`);
  if (remedy) console.error(`  ${remedy}`);
  console.error('');
  process.exit(1);
};

const cer = process.argv[2];
if (!cer) die('usage: pnpm apple:cert <path-to-certificate.cer>');
if (!existsSync(cer)) die(`no such file: ${cer}`);
if (process.platform !== 'darwin') die('this needs macOS — `security` lives there');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts });

// ── 1. What did Apple send? ────────────────────────────────────────────────
let subject;
try {
  // Apple ships DER; a .cer someone re-saved may be PEM. Try both rather than
  // making the caller know which they have.
  const der = readFileSync(cer);
  for (const form of ['der', 'pem']) {
    try {
      subject = run('openssl', ['x509', '-inform', form, '-noout', '-subject'], { input: der });
      break;
    } catch {
      /* try the other encoding */
    }
  }
} catch (err) {
  die(`could not read ${cer}: ${err.message}`);
}
if (!subject) die(`${cer} is not a certificate in either DER or PEM form`);

const cn = /CN\s*=\s*([^,\n/]+)/.exec(subject)?.[1]?.trim();
const ou = /OU\s*=\s*([^,\n/]+)/.exec(subject)?.[1]?.trim();
if (!cn) die('that certificate names no subject');
console.log(`\n  certificate  ${cn}`);
console.log(`  team         ${ou ?? 'unknown'}`);
if (!/^Developer ID Application:/.test(cn)) {
  die(
    `that is a "${cn.split(':')[0]}" certificate`,
    'Only a Developer ID Application certificate can sign software distributed outside the App Store.',
  );
}

// ── 2. Install it, then prove it paired ────────────────────────────────────
try {
  run('security', ['import', cer, '-k', `${process.env.HOME}/Library/Keychains/login.keychain-db`, '-A'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  // "already exists in the keychain" is the expected result of running this
  // twice, and the find-identity check below is the real test either way.
  const out = `${err.stderr ?? ''}${err.stdout ?? ''}`;
  if (!/already exists/i.test(out)) die(`could not import the certificate: ${out.trim() || err.message}`);
  console.log('  install      already in the keychain');
}

const identities = run('security', ['find-identity', '-v', '-p', 'codesigning']);
const line = identities.split('\n').find((l) => l.includes(cn));
if (!line) {
  die(
    'the certificate installed but has NO private key in this keychain, so it cannot sign',
    'The CSR that produced it was made on a different machine. Redo the CSR here, revoke this certificate, and issue a new one.',
  );
}
const sha1 = /\b([0-9A-F]{40})\b/.exec(line)?.[1];
console.log(`  paired       ${sha1} — a private key for it is in this keychain`);

// ── 3. Export the .p12 the workflow consumes ───────────────────────────────
// Generated, not chosen: this password protects a signing identity and is
// stored straight into a GitHub secret, so it never needs to be memorable.
const password = randomBytes(24).toString('base64url');
const dir = mkdtempSync(join(tmpdir(), 'lilypad-cert-'));
const p12 = join(dir, 'cert.p12');
try {
  console.log('\n  exporting… macOS will ask permission to use the private key.\n');
  run('security', ['export', '-k', 'login.keychain-db', '-t', 'identities', '-f', 'pkcs12',
    '-P', password, '-o', p12]);
  const b64 = readFileSync(p12).toString('base64');

  console.log('  set these three, or run with --set to do it now:\n');
  console.log(`    gh secret set APPLE_SIGNING_IDENTITY --body ${JSON.stringify(cn)}`);
  console.log('    gh secret set APPLE_CERTIFICATE           # paste the base64 below');
  console.log('    gh secret set APPLE_CERTIFICATE_PASSWORD  # paste the password below');
  console.log(`\n  password: ${password}`);

  if (process.argv.includes('--set')) {
    const set = (name, body) =>
      execFileSync('gh', ['secret', 'set', name], { input: body, stdio: ['pipe', 'inherit', 'inherit'] });
    set('APPLE_CERTIFICATE', b64);
    set('APPLE_CERTIFICATE_PASSWORD', password);
    set('APPLE_SIGNING_IDENTITY', cn);
    if (ou) set('APPLE_TEAM_ID', ou);
    console.log('\n  set: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID');
    console.log('  now run: gh workflow run apple-check.yml');
  } else {
    console.log(`\n  base64 of the .p12:\n\n${b64}\n`);
  }
} finally {
  // The .p12 is a signing identity. It does not get to linger in /tmp.
  rmSync(dir, { recursive: true, force: true });
}

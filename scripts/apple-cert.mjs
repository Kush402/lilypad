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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

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
  run(
    'security',
    ['import', cer, '-k', `${process.env.HOME}/Library/Keychains/login.keychain-db`, '-A'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
} catch (err) {
  // "already exists in the keychain" is the expected result of running this
  // twice, and the find-identity check below is the real test either way.
  const out = `${err.stderr ?? ''}${err.stdout ?? ''}`;
  if (!/already exists/i.test(out))
    die(`could not import the certificate: ${out.trim() || err.message}`);
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
await exportAndSet();

async function exportAndSet() {
  // Generated, not chosen: this password protects a signing identity and is
  // stored straight into a GitHub secret, so it never needs to be memorable.
  const password = randomBytes(24).toString('base64url');
  const dir = mkdtempSync(join(tmpdir(), 'lilypad-cert-'));
  const everything = join(dir, 'all.p12');
  const p12 = join(dir, 'cert.p12');
  try {
    console.log('\n  exporting… macOS will ask permission to use the private key.\n');

    // `security export -t identities` takes NO filter — it exports EVERY identity
    // in the keychain. Handing that to APPLE_CERTIFICATE would put unrelated
    // private keys (an iOS distribution key, personal development keys) into a
    // secret that only needs one. So export everything, then keep the single
    // identity whose certificate we just installed and throw the rest away.
    run('security', [
      'export',
      '-k',
      'login.keychain-db',
      '-t',
      'identities',
      '-f',
      'pkcs12',
      '-P',
      password,
      '-o',
      everything,
    ]);

    const pem = run(
      'openssl',
      ['pkcs12', '-in', everything, '-passin', `pass:${password}`, '-nodes', '-legacy'],
      { maxBuffer: 32 * 1024 * 1024 },
    );

    // Each bag is preceded by its friendlyName/subject header. Split on the
    // headers, keep the block whose subject is the certificate we installed.
    const wanted = extractPair(pem, cn);
    if (!wanted) die('exported the keychain but could not find the certificate in it');
    const bundle = join(dir, 'one.pem');
    writeFileSync(bundle, wanted, { mode: 0o600 });

    run('openssl', [
      'pkcs12',
      '-export',
      '-legacy',
      '-in',
      bundle,
      '-out',
      p12,
      '-passout',
      `pass:${password}`,
      '-name',
      cn,
    ]);

    // Prove the trimmed bundle really is one identity and the right one.
    const check = run(
      'openssl',
      ['pkcs12', '-in', p12, '-passin', `pass:${password}`, '-nokeys', '-legacy'],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const subjects = [...check.matchAll(/subject=.*?CN\s*=\s*([^,\n/]+)/g)].map((m) => m[1].trim());
    if (subjects.length !== 1 || subjects[0] !== cn) {
      die(`the exported .p12 contains ${subjects.length} certificate(s): ${subjects.join(', ')}`);
    }
    console.log(`  exported     one identity — ${cn}`);

    const b64 = readFileSync(p12).toString('base64');

    // Never printed, with or without --set. A base64 .p12 and its password
    // together are the private key in plain sight, and anything printed here
    // lands in a terminal scrollback, a CI log, or a chat transcript. The only
    // way this material leaves the process is straight into `gh secret set`.
    if (!process.argv.includes('--set')) {
      console.log('  dry run      nothing uploaded. Re-run with --set to store the four secrets.');
      return;
    }

    const set = (name, body) =>
      execFileSync('gh', ['secret', 'set', name], {
        input: body,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
    set('APPLE_CERTIFICATE', b64);
    set('APPLE_CERTIFICATE_PASSWORD', password);
    set('APPLE_SIGNING_IDENTITY', cn);
    if (ou) set('APPLE_TEAM_ID', ou);
    console.log(
      '  set          APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID',
    );
    console.log('\n  now run: gh workflow run apple-check.yml\n');
  } finally {
    // The .p12s are signing identities. They do not get to linger in /tmp.
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Pull the one certificate/key pair whose subject CN matches, out of the PEM
 * dump of a whole keychain. `openssl pkcs12 -nodes` emits every bag in
 * sequence, each headed by its own subject/issuer lines, so the pair we want is
 * the CERTIFICATE block under the matching header plus the PRIVATE KEY block
 * that verifies against it.
 */
function extractPair(pem, subjectCn) {
  const certs = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g),
  ].map((m) => m[0]);
  const keys = [
    ...pem.matchAll(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g),
  ].map((m) => m[0]);

  const cert = certs.find((c) => {
    const subject = run('openssl', ['x509', '-noout', '-subject'], { input: c });
    return /CN\s*=\s*([^,\n/]+)/.exec(subject)?.[1]?.trim() === subjectCn;
  });
  if (!cert) return null;

  // Match by public key rather than by position: bag order is not guaranteed.
  const certPub = run('openssl', ['x509', '-noout', '-pubkey'], { input: cert });
  const key = keys.find((k) => {
    try {
      return run('openssl', ['pkey', '-pubout'], { input: k }) === certPub;
    } catch {
      return false;
    }
  });
  if (!key) return null;
  return `${key}\n${cert}\n`;
}

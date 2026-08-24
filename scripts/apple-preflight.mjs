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
import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The bundle id the iOS app actually builds as. Read from the Xcode project
 * rather than hard-coded here, because that file is what `xcodebuild` obeys —
 * a copy in this script could agree with the docs and disagree with the build. */
function iosAppIdentifier() {
  if (val('IOS_APP_IDENTIFIER')) return val('IOS_APP_IDENTIFIER');
  const pbx = join(
    dirname(dirname(fileURLToPath(import.meta.url))),
    'apps/mobile/ios/LilypadMobile.xcodeproj/project.pbxproj',
  );
  try {
    // The test target is `<id>.tests`; the app target is the one without it.
    const all = [
      ...readFileSync(pbx, 'utf8').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;\s]+);/g),
    ].map((m) => m[1]);
    return all.find((id) => id && !id.endsWith('.tests')) ?? null;
  } catch {
    return null;
  }
}

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

// Which pipeline is asking. The Mac app needs a Developer ID certificate and
// the notary service and NO app record; iOS needs an app record and never
// touches the notary. Checking both sets everywhere means a desktop release
// fails on a missing TestFlight record — which the failure message itself says
// is not required. Default `all`, so a human running `pnpm apple:check` still
// sees everything.
const scope = val('APPLE_CHECK_LANE') ?? 'all';
if (!['all', 'desktop', 'ios'].includes(scope))
  bad(`APPLE_CHECK_LANE is ${JSON.stringify(scope)}`, 'Expected all, desktop or ios.');
const wantsDesktop = scope !== 'ios';
const wantsIos = scope !== 'desktop';

console.log(`\nApple signing preflight${scope === 'all' ? '' : ` — ${scope}`}\n`);

// ── Team id ────────────────────────────────────────────────────────────────
const team = val('APPLE_TEAM_ID');
if (!team) bad('APPLE_TEAM_ID is not set', 'Apple Developer → Membership details → Team ID.');
else if (!/^[A-Z0-9]{10}$/.test(team))
  bad(`APPLE_TEAM_ID is ${JSON.stringify(team)}`, 'A Team ID is 10 upper-case alphanumerics.');
else ok(`APPLE_TEAM_ID ${team}`);

// Desktop-only inputs. mobile-ios.yml has none of these and must not be told so.
if (wantsDesktop) {
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
        [
          'pkcs12',
          '-in',
          file,
          '-nokeys',
          '-passin',
          `pass:${process.env.APPLE_CERTIFICATE_PASSWORD ?? ''}`,
          '-legacy',
        ],
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
      'App Store Connect → Users and Access → Integrations → App Store Connect API → generate a key with the App Manager role. Developer is enough to notarize the Mac app but NOT to upload to TestFlight, and the .p8 downloads once — a key with the wrong role has to be revoked and remade. See docs/apple-setup.md.',
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

  // A Developer ID certificate needs no app record, so the Mac app can ship from
  // one Apple team while iOS ships from the team that owns the App Store Connect
  // record. When IOS_TEAM_ID declares that split, two different keys under the
  // two sets of names is the correct configuration rather than a typo.
}

const iosTeam = val('IOS_TEAM_ID') ?? team;
const splitTeams = Boolean(val('IOS_TEAM_ID')) && val('IOS_TEAM_ID') !== team;
if (splitTeams) ok(`IOS_TEAM_ID ${iosTeam} — iOS ships from a different team than the Mac app`);

// iOS-only inputs. release.yml never reads them.
if (wantsIos) {
  // ── The same key, under the names the iOS lane reads ──────────────────────
  // `release.yml` (desktop notarization) and `mobile-ios.yml` (TestFlight) can
  // use ONE App Store Connect key, but they read it under different names. A key
  // that works for one and is missing for the other is the likeliest way to have
  // half a release pipeline.
  console.log('\niOS TestFlight lane reads the same key under different names:\n');
  if (!val('ASC_KEY_P8'))
    bad('ASC_KEY_P8 is not set', 'Same .p8 as APPLE_API_KEY_P8, base64-encoded.');
  else decodeBase64('ASC_KEY_P8', 'BEGIN PRIVATE KEY');
  for (const [name, mirror] of [
    ['ASC_KEY_ID', 'APPLE_API_KEY'],
    ['ASC_ISSUER_ID', 'APPLE_API_ISSUER'],
  ]) {
    const v = val(name);
    if (!v) bad(`${name} is not set`, `Same value as ${mirror}.`);
    else if (val(mirror) && v !== val(mirror) && !splitTeams)
      bad(`${name} and ${mirror} disagree`, 'They are the same key; one of them is a typo.');
    else ok(`${name} ${v}`);
  }
}

// ── Ask Apple ─────────────────────────────────────────────────────────────
// Everything above checks that the values are well FORMED. That is not the
// same as Apple accepting them, and the difference is a twenty-minute release
// run: a mistyped Issuer ID, a revoked key, or a key created with the wrong
// role all look perfect on paper. One signed request settles it.
//
// ES256 over the .p8, exactly the way notarytool and fastlane build their JWT.
// Skipped when the key or issuer is missing — there is nothing to ask with —
// and a network failure is reported as unknown rather than as a bad key.

/**
 * App Store Connect and the notary service are different services behind the
 * same key. `askApple` proving one says nothing about the other, and the Mac
 * release depends only on the second. `notarytool history` authenticates and
 * returns without submitting anything, which is the cheapest possible proof.
 *
 * macOS only — notarytool ships with Xcode. Skipped elsewhere with a line
 * saying so rather than silently passing.
 */
function askNotary({ b64, keyId, issuer }) {
  if (!b64 || !keyId || !issuer) return;
  if (process.platform !== 'darwin')
    return skip('cannot check notarization off macOS (needs notarytool)');

  const dir = mkdtempSync(join(tmpdir(), 'lilypad-notary-'));
  const file = join(dir, 'key.p8');
  try {
    writeFileSync(file, Buffer.from(b64, 'base64'), { mode: 0o600 });
    execFileSync(
      'xcrun',
      ['notarytool', 'history', '--key', file, '--key-id', keyId, '--issuer', issuer],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    ok('the notary service accepts this key — notarization will authenticate');
  } catch (err) {
    const out = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim();
    if (/xcrun|notarytool/i.test(out) && /not found|unable to find/i.test(out)) {
      skip('notarytool is not installed — notarization not verified');
    } else {
      bad(
        'the notary service rejected this key',
        `Notarization will fail even though App Store Connect accepts the key. ${out.split('\n')[0] ?? ''}`,
      );
    }
  } finally {
    unlinkSync(file);
  }
}

async function askApple({ label, b64, keyId, issuer, team }) {
  console.log(`\nAgainst the live App Store Connect API${label ? ` (${label})` : ''}:\n`);
  if (!b64 || !keyId || !issuer) {
    skip('not asking Apple — need the key, its Key ID and the Issuer ID first');
    return;
  }

  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  // A TEAM key names the team's Issuer ID in `iss`. An INDIVIDUAL key has no
  // Issuer ID at all and identifies itself with `sub: "user"` instead. Both
  // download as a .p8 and both show a Key ID, so the two are indistinguishable
  // on disk — but notarytool and fastlane only ever build the team form, so an
  // individual key fails every workflow with a flat 401.
  const mint = (claims) => {
    const header = b64url({ alg: 'ES256', kid: keyId, typ: 'JWT' });
    const payload = b64url({ iat: now, exp: now + 300, aud: 'appstoreconnect-v1', ...claims });
    const signer = createSign('SHA256');
    signer.update(`${header}.${payload}`);
    // ASC requires the JOSE fixed-width r||s form, not the DER that
    // createSign emits by default.
    const sig = signer.sign(
      { key: Buffer.from(b64, 'base64'), dsaEncoding: 'ieee-p1363' },
      'base64url',
    );
    return `${header}.${payload}.${sig}`;
  };

  let jwt;
  try {
    jwt = mint({ iss: issuer });
  } catch (err) {
    bad(
      `could not sign a token with the .p8: ${err.message}`,
      'The key is not a usable ES256 private key.',
    );
    return;
  }

  /** GET an ASC path. Returns null on a network failure, `{ status, body }`
   * otherwise, so each caller can distinguish "Apple said no" from "no answer". */
  const get = async (path, token = jwt) => {
    try {
      const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      return { status: res.status, body: res.ok ? await res.json().catch(() => ({})) : null };
    } catch {
      return null;
    }
  };

  const apps = await get('/v1/apps?limit=200');
  if (!apps) {
    skip('could not reach App Store Connect — credentials not verified');
    return;
  }

  if (apps.status === 401) {
    // Before blaming the Issuer ID, check whether this is an individual key.
    // Same .p8, same Key ID, different claim shape — if that one is accepted
    // the key is real and the workflows still cannot use it.
    const asIndividual = await get('/v1/apps?limit=1', mint({ sub: 'user' }));
    if (asIndividual?.status === 200) {
      bad(
        `Key ID ${keyId} is an INDIVIDUAL App Store Connect key, not a team key`,
        'Apple accepts it, but notarytool and fastlane only send the team form of the token, so every workflow gets a 401. Generate a key under Users and Access → Integrations → App Store Connect API → Team Keys.',
      );
    } else {
      bad(
        'App Store Connect rejected the key (401)',
        'Wrong Issuer ID, a revoked key, or the .p8 does not belong to this Key ID.',
      );
    }
    return;
  }
  if (apps.status === 403) {
    bad(
      'App Store Connect accepted the key but refused the request (403)',
      'The key authenticates but lacks permission — it needs the App Manager role for TestFlight uploads.',
    );
    return;
  }
  if (apps.status !== 200) {
    skip(`App Store Connect answered HTTP ${apps.status} — credentials not verified`);
    return;
  }
  ok('Apple accepted the key — Issuer ID, Key ID and .p8 all agree');

  // ── Whose account is this? ──────────────────────────────────────────────
  // A key that authenticates is not automatically a key for YOUR team, and a
  // build signed by one team cannot be notarized by another's key: notarytool
  // rejects it after the upload, not before. The ASC API exposes no "who am I"
  // endpoint, but every certificate carries the team id in its subject OU.
  const teamVar = label === 'iOS' ? 'IOS_TEAM_ID' : 'APPLE_TEAM_ID';
  const certs = await get('/v1/certificates?limit=200');
  const certList = certs?.body?.data ?? [];
  const teams = new Set();
  for (const c of certList) {
    const der = c?.attributes?.certificateContent;
    if (!der) continue;
    try {
      const subject = execFileSync('openssl', ['x509', '-inform', 'der', '-noout', '-subject'], {
        input: Buffer.from(der, 'base64'),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const ou = /OU\s*=\s*([^,\n/]+)/.exec(subject)?.[1]?.trim();
      if (ou) teams.add(ou);
    } catch {
      /* openssl missing or an unparseable cert — the other checks still run */
    }
  }
  if (teams.size === 0) {
    skip('this key’s account has no certificates, so its Team ID could not be confirmed');
  } else if (!team) {
    skip(`${teamVar} is unset — this key belongs to ${[...teams].join(', ')}`);
  } else if (teams.has(team)) {
    ok(`the key belongs to team ${team}`);
  } else {
    bad(
      `this key belongs to team ${[...teams].join(', ')}, not ${teamVar} ${team}`,
      'A build signed by one team cannot be notarized or uploaded with another team’s key. Use a key generated inside the same Apple Developer account the signing certificate comes from.',
    );
  }

  // A Developer ID Application certificate is what makes the Mac app open
  // without the unidentified-developer dialog. Its absence from the account is
  // the difference between "not uploaded yet" and "does not exist yet".
  if (certList.length && wantsDesktop) {
    // Apple reports the type as DEVELOPER_ID_APPLICATION_G2 for anything the G2
    // sub-CA issued, which is every certificate created now. Matching the bare
    // name found nothing and reported a correctly configured account as having
    // no certificate — a false failure in the check that gates the release it
    // exists to protect.
    const devId = certList.filter((c) =>
      String(c?.attributes?.certificateType ?? '').startsWith('DEVELOPER_ID_APPLICATION'),
    );
    if (devId.length)
      ok(`${devId.length} Developer ID Application certificate(s) exist in this account`);
    else
      bad(
        'this account has no Developer ID Application certificate',
        'Without one the Mac app can only be ad-hoc signed. Apple Developer → Certificates → + → Developer ID Application. Only the Account Holder can create it.',
      );
  }

  // ── Is Lilypad in this account? ─────────────────────────────────────────
  // The old check only counted app records. Three records belonging to other
  // products passed it while nothing named Lilypad existed.
  if (!wantsIos) return;
  const wanted = iosAppIdentifier();
  if (!wanted) {
    skip('could not read PRODUCT_BUNDLE_IDENTIFIER from the Xcode project');
    return;
  }
  const ids = await get(`/v1/bundleIds?limit=200`);
  const registered = (ids?.body?.data ?? []).some((d) => d?.attributes?.identifier === wanted);
  if (registered) ok(`App ID ${wanted} is registered`);
  else
    bad(
      `App ID ${wanted} is not registered in this account`,
      'Apple Developer → Identifiers → + → App IDs → App, explicit bundle id. The App Store Connect record cannot be created before it exists. See docs/apple-setup.md §3.',
    );

  const record = (apps.body?.data ?? []).find((d) => d?.attributes?.bundleId === wanted);
  if (record) ok(`App Store Connect record ${record.id} — “${record.attributes.name}”`);
  else
    bad(
      `no App Store Connect record uses ${wanted}`,
      'TestFlight uploads need one: App Store Connect → Apps → + → New App, selecting that bundle id. Notarizing the Mac app does NOT need this.',
    );
}

// One key normally serves both pipelines, so ask once. When IOS_TEAM_ID splits
// them, the two keys are different credentials for different accounts and each
// has to be checked on its own — a single answer would be right about one lane
// and silent about the other.
const lanes = [
  {
    label: splitTeams ? 'Mac app' : '',
    b64: val('APPLE_API_KEY_P8') ?? val('ASC_KEY_P8'),
    keyId: val('APPLE_API_KEY') ?? val('ASC_KEY_ID'),
    issuer: val('APPLE_API_ISSUER') ?? val('ASC_ISSUER_ID'),
    team,
  },
];
if (splitTeams) {
  lanes.push({
    label: 'iOS',
    b64: val('ASC_KEY_P8'),
    keyId: val('ASC_KEY_ID'),
    issuer: val('ASC_ISSUER_ID'),
    team: iosTeam,
  });
}
for (const lane of lanes) {
  await askApple(lane);
  // Only the Mac app is notarized; the iOS lane never talks to the notary.
  if (lane.label !== 'iOS' && wantsDesktop) askNotary(lane);
}

console.log(
  problems === 0
    ? '\nAll Apple signing inputs look right.\n'
    : `\n${problems} problem(s). Nothing was uploaded or changed.\n`,
);
process.exit(problems === 0 ? 0 : 1);

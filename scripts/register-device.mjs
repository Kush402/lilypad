#!/usr/bin/env node
/**
 * Register a test device with App Store Connect and mint an ad-hoc profile.
 *
 * ### Why this runs in CI rather than on a laptop
 *
 * The App Store Connect credentials live as repository secrets. A laptop that
 * does not have them cannot register a device, and a GitHub secret cannot be
 * read back out — the API returns names, never values, and Actions masks the
 * value in logs. So the work comes to the secrets instead of the other way
 * round: this script *uses* `ASC_ISSUER_ID` and never prints it, and what
 * leaves the job is a provisioning profile, which is not secret.
 *
 * Do not add a step that echoes any of these values. This repository is
 * public, which makes workflow logs public and permanent, and the same trick
 * that would reveal the issuer id would reveal the signing key beside it.
 *
 * ### What it does
 *
 *   1. Registers the UDID (an already-registered device is a success, not an
 *      error — re-running must not fail).
 *   2. Finds the distribution certificate to bind the profile to.
 *   3. Creates an ad-hoc profile over every registered device, replacing an
 *      existing one of the same name: a profile's device list is fixed at
 *      creation, so adding a device means making a new one.
 *   4. Writes the profile to `--out`.
 *
 * Ad-hoc rather than development, because the only `AR2Q4Y465L` identity on
 * the Mac that will install this is `iPhone Distribution`. The development
 * certificate there belongs to a different team and cannot sign this app id.
 *
 * Usage:
 *   node scripts/register-device.mjs --udid <40-hex-or-24-dash> --name "iPhone" --out profile.mobileprovision
 */
import { createSign } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const API = 'https://api.appstoreconnect.apple.com';
const BUNDLE_ID = process.env.IOS_APP_IDENTIFIER || 'com.takedia.lilypad';
const PROFILE_NAME = process.env.PROFILE_NAME || 'Lilypad Ad Hoc (CI devices)';

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function die(message) {
  console.error(`register-device: ${message}`);
  process.exit(1);
}

const udid = arg('--udid') || die('--udid is required');
const deviceName = arg('--name', 'CI test device');
const outPath = arg('--out', 'profile.mobileprovision');

const keyId = process.env.ASC_KEY_ID || die('ASC_KEY_ID is not set');
const issuer = process.env.ASC_ISSUER_ID || die('ASC_ISSUER_ID is not set');
const keyB64 = process.env.ASC_KEY_P8 || die('ASC_KEY_P8 is not set');

/** The same ES256 token `apple-preflight.mjs` mints: JOSE r||s, not DER. */
function token() {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const payload = b64url({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(
    { key: Buffer.from(keyB64, 'base64'), dsaEncoding: 'ieee-p1363' },
    'base64url',
  );
  return `${header}.${payload}.${sig}`;
}

const JWT = token();

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${JWT}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* Apple answered with something that is not JSON; `text` is the evidence */
  }
  return { status: res.status, json, text };
}

/** Apple's error detail, with nothing from the request echoed back. */
function detail(result) {
  const errors = result.json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) => `${e.title}: ${e.detail}`).join('; ');
  }
  return `HTTP ${result.status}`;
}

async function registerDevice() {
  const created = await call('POST', '/v1/devices', {
    data: {
      type: 'devices',
      attributes: { name: deviceName, platform: 'IOS', udid },
    },
  });
  if (created.status === 201) {
    console.log(`registered ${udid} as "${deviceName}"`);
    return;
  }
  // Already registered is the ordinary case on a re-run, and Apple reports it
  // as a 409 conflict. Treat it as done rather than as a failure.
  const already = /already exist|has already been taken|ENTITY_ERROR/i.test(created.text || '');
  if (created.status === 409 && already) {
    console.log(`${udid} was already registered`);
    return;
  }
  die(`could not register the device — ${detail(created)}`);
}

async function distributionCertificateId() {
  const certs = await call('GET', '/v1/certificates?limit=200');
  if (certs.status !== 200) die(`could not list certificates — ${detail(certs)}`);
  const usable = (certs.json?.data ?? []).filter((c) =>
    ['IOS_DISTRIBUTION', 'DISTRIBUTION'].includes(c.attributes?.certificateType),
  );
  if (usable.length === 0) {
    die('no iOS distribution certificate on this team — an ad-hoc profile needs one');
  }
  // The longest-lived one, so a profile is not minted against a certificate
  // that expires next week.
  usable.sort(
    (a, b) =>
      Date.parse(b.attributes?.expirationDate ?? 0) - Date.parse(a.attributes?.expirationDate ?? 0),
  );
  const chosen = usable[0];
  console.log(
    `using ${chosen.attributes.certificateType} expiring ${chosen.attributes.expirationDate}`,
  );
  return chosen.id;
}

async function bundleIdResourceId() {
  const ids = await call('GET', `/v1/bundleIds?limit=200&filter[identifier]=${BUNDLE_ID}`);
  if (ids.status !== 200) die(`could not list bundle ids — ${detail(ids)}`);
  const match = (ids.json?.data ?? []).find((b) => b.attributes?.identifier === BUNDLE_ID);
  if (!match) die(`no bundle id resource for ${BUNDLE_ID} on this team`);
  return match.id;
}

async function enabledDeviceIds() {
  const devices = await call('GET', '/v1/devices?limit=200');
  if (devices.status !== 200) die(`could not list devices — ${detail(devices)}`);
  const enabled = (devices.json?.data ?? []).filter(
    (d) => d.attributes?.status === 'ENABLED' && d.attributes?.platform === 'IOS',
  );
  if (enabled.length === 0) die('no enabled iOS devices on this team');
  console.log(`including ${enabled.length} enabled iOS device(s)`);
  return enabled.map((d) => d.id);
}

async function replaceProfile(certId, bundleResourceId, deviceIds) {
  // A profile's device list is fixed when it is created, so "add a device"
  // means delete and recreate. Deleting by name keeps re-runs idempotent
  // instead of accumulating one profile per run.
  const existing = await call('GET', '/v1/profiles?limit=200');
  if (existing.status === 200) {
    for (const profile of existing.json?.data ?? []) {
      if (profile.attributes?.name === PROFILE_NAME) {
        const gone = await call('DELETE', `/v1/profiles/${profile.id}`);
        console.log(
          gone.status === 204
            ? `replaced the previous "${PROFILE_NAME}"`
            : `could not delete the previous profile (${detail(gone)}) — continuing`,
        );
      }
    }
  }

  const created = await call('POST', '/v1/profiles', {
    data: {
      type: 'profiles',
      attributes: { name: PROFILE_NAME, profileType: 'IOS_APP_ADHOC' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundleResourceId } },
        certificates: { data: [{ type: 'certificates', id: certId }] },
        devices: { data: deviceIds.map((id) => ({ type: 'devices', id })) },
      },
    },
  });
  if (created.status !== 201) die(`could not create the profile — ${detail(created)}`);
  const content = created.json?.data?.attributes?.profileContent;
  if (!content) die('Apple created the profile but returned no content');
  return Buffer.from(content, 'base64');
}

const run = async () => {
  await registerDevice();
  const [certId, bundleResourceId, deviceIds] = [
    await distributionCertificateId(),
    await bundleIdResourceId(),
    await enabledDeviceIds(),
  ];
  const profile = await replaceProfile(certId, bundleResourceId, deviceIds);
  writeFileSync(outPath, profile);
  console.log(`wrote ${outPath} (${profile.length} bytes)`);
};

run().catch((err) => die(err?.message ?? String(err)));

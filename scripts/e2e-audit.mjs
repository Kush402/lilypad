/**
 * Production-style end-to-end audit of the whole product flow, against a LIVE
 * backend with real Postgres and real Redis.
 *
 *   node apps/backend/dist/index.js &          # or point BASE at any deployment
 *   BASE=http://127.0.0.1:8080 node scripts/e2e-audit.mjs
 *
 * Complements `apps/mobile/src/lib/deviceFlow.e2e.test.ts`, which drives the
 * phone's own identity/auth modules: this drives the REST surface the way a
 * client does, and covers the half that one does not — password signup and
 * sign-in, the device list, pairing, connect authorization, revocation and
 * recovery.
 *
 * No dependencies: Ed25519 comes from `node:crypto`, so it runs from a bare
 * checkout and against a deployed backend without installing anything.
 *
 * Rate limits are real and shared per IP (signup is 5/minute), so running this
 * repeatedly within a minute WILL produce 429s. That is the product working,
 * not a failure — wait out the window and re-run.
 *
 * **It cleans up after itself.** Every run signs up
 * `audit-<random>@example.test` and deletes that account again at the end, via
 * the same `DELETE /account` a customer uses — which is also the last check in
 * the file, because a deletion route that only the tests believe in is not a
 * deletion route. `.test` is reserved by RFC 6761, so the address can never
 * collide with a real one.
 *
 * If the run fails partway the account survives, and removing it then needs SQL
 * on the host. That is the honest boundary: a script that force-deleted on the
 * way out of a failure would destroy the state you wanted to look at.
 */
import { randomBytes, generateKeyPairSync, sign as nodeSign } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8099';
const PREFIX = 'lilypad-device-auth:v1:';
const b64u = (b) => Buffer.from(b).toString('base64url');
const tag = randomBytes(4).toString('hex');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

async function req(method, path, body, bearer) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      // Only when there IS a body: Fastify rejects a bodyless request that
      // declares JSON with FST_ERR_CTP_EMPTY_JSON_BODY. The mobile client
      // handles this the same way (`lib/accountDevices.ts`).
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}
const post = (p, b, t) => req('POST', p, b, t);

/** An Ed25519 identity, exactly as a real client holds one. `jwk.x` is the raw
 * 32-byte public key in base64url — the encoding the wire format uses. */
function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x };
}

/** Prove possession of the private half over a server-issued challenge, with
 * the domain-separation prefix (ADR-0002). */
async function proof(key) {
  const { json } = await post('/devices/challenge', {});
  const signature = nodeSign(null, Buffer.from(PREFIX + json.challenge, 'utf8'), key.privateKey);
  return { challenge: json.challenge, publicKey: key.publicKey, signature: b64u(signature) };
}

// ── 1. Signup + login ────────────────────────────────────────────────────────
const email = `audit-${tag}@example.test`;
const password = 'a-perfectly-ordinary-passphrase';
const signup = await post('/auth/signup', { name: 'Audit User', email, password });
check('signup with name + email + password', signup.status === 201, `HTTP ${signup.status}`);

const dupe = await post('/auth/signup', { name: 'Audit User', email, password });
check('duplicate signup is refused', dupe.status === 409, `HTTP ${dupe.status}`);

const login = await post('/auth/password', { email, password });
check('password sign-in returns a session', login.status === 200 && !!login.json.accessToken);

const wrong = await post('/auth/password', { email, password: password + 'x' });
check('wrong password is refused', wrong.status === 401, `HTTP ${wrong.status}`);

const unknown = await post('/auth/password', { email: `nobody-${tag}@example.test`, password });
check(
  'unknown account answers identically to a wrong password',
  unknown.status === wrong.status && unknown.json.error === wrong.json.error,
  `${unknown.status} ${unknown.json.error}`,
);

// ── 2. Phone enrolls (account identity → device identity) ────────────────────
const phone = newKey();
const enrolled = await post(
  '/devices/enroll',
  {
    ...(await proof(phone)),
    kind: 'mobile',
    fingerprint: `mobile-${tag}`,
    name: 'Audit iPhone',
    platform: 'ios',
  },
  login.json.accessToken,
);
check('phone enrolls against the account', enrolled.status === 200, `HTTP ${enrolled.status}`);
const phoneToken = enrolled.json.accessToken;

// ── 3. A computer may not put itself on an account (ADR-0010) ────────────────
const laptop = newKey();
const selfLink = await post(
  '/devices/enroll',
  { ...(await proof(laptop)), kind: 'desktop', fingerprint: `desktop-${tag}` },
  login.json.accessToken,
);
check(
  'a desktop cannot enroll itself, even signed in',
  selfLink.status === 403 && selfLink.json.error === 'desktop_enrollment_requires_approval',
  `HTTP ${selfLink.status}`,
);

// ── 4. Linking: laptop shows a code, phone approves it ───────────────────────
const code = await post('/devices/enrollment-code', {
  ...(await proof(laptop)),
  fingerprint: `desktop-${tag}`,
  name: 'Audit MacBook',
  platform: 'macos',
});
check('laptop mints an enrollment code', code.status === 201, `HTTP ${code.status}`);
check('the code carries the address the PHONE should use', !!code.json.apiBaseUrl);

const beforeLink = await post('/devices/token', await proof(laptop));
check(
  'laptop cannot sign in before approval',
  beforeLink.status === 403 && beforeLink.json.error === 'device_not_enrolled',
  `HTTP ${beforeLink.status}`,
);

const approved = await post(
  '/devices/enrollment-code/approve',
  { code: code.json.code },
  phoneToken,
);
check('phone approves — the laptop is linked', approved.status === 200, `HTTP ${approved.status}`);
check('approval delivers the per-pair connect secret', !!approved.json.pairSecret);

const replay = await post('/devices/enrollment-code/approve', { code: code.json.code }, phoneToken);
check('the code is single-use', replay.status === 404, `HTTP ${replay.status}`);

const laptopAuth = await post('/devices/token', await proof(laptop));
check('laptop can now sign itself in', laptopAuth.status === 200, `HTTP ${laptopAuth.status}`);
const laptopToken = laptopAuth.json.accessToken;

// ── 5. Device management ─────────────────────────────────────────────────────
const list = await req('GET', '/devices', undefined, phoneToken);
const kinds = (list.json.devices ?? []).map((d) => `${d.kind}:${d.state}`).sort();
check(
  'both devices appear on the account as linked',
  list.status === 200 && kinds.join(',') === 'desktop:linked,mobile:linked',
  kinds.join(',') || `HTTP ${list.status}`,
);
check(
  'fingerprints are masked in the listing',
  (list.json.devices ?? []).every((d) => d.fingerprint.startsWith('…')),
);

const anon = await req('GET', '/devices');
check('the device list refuses an anonymous caller', anon.status === 401, `HTTP ${anon.status}`);

// ── 6. Pairing (phone ↔ linked computer) ─────────────────────────────────────
const pairing = await post(
  '/pairing/create',
  { deviceId: `desktop-${tag}`, deviceName: 'Audit MacBook', platform: 'macos' },
  laptopToken,
);
check('linked laptop mints a pairing QR', pairing.status === 201, `HTTP ${pairing.status}`);

const stolen = await post('/pairing/create', { deviceId: `desktop-${tag}`, deviceName: 'x' });
check(
  'a linked laptop’s pairing surface refuses an untokened caller',
  stolen.status === 404,
  `HTTP ${stolen.status}`,
);

const redeem = await post(
  '/pairing/redeem',
  {
    token: pairing.json.token,
    deviceId: `mobile-${tag}`,
    deviceName: 'Audit iPhone',
    platform: 'ios',
  },
  phoneToken,
);
check(
  'phone redeems the QR',
  redeem.status === 200 && !!redeem.json.roomId,
  `HTTP ${redeem.status}`,
);

const reuse = await post(
  '/pairing/redeem',
  { token: pairing.json.token, deviceId: `mobile-${tag}`, platform: 'ios' },
  phoneToken,
);
check('the pairing token is single-use', reuse.status === 410, `HTTP ${reuse.status}`);

// ── 7. No-QR reconnect authorization ─────────────────────────────────────────
const ring = await post(
  '/connect/request',
  {
    desktopDeviceId: `desktop-${tag}`,
    mobileDeviceId: `mobile-${tag}`,
    pairSecret: approved.json.pairSecret,
  },
  phoneToken,
);
check(
  'a trusted phone is authorized to ring its laptop (offline → 503, not 404)',
  ring.status === 503 && ring.json.error === 'desktop_offline',
  `HTTP ${ring.status} ${ring.json.error}`,
);

const badSecret = await post(
  '/connect/request',
  { desktopDeviceId: `desktop-${tag}`, mobileDeviceId: `mobile-${tag}`, pairSecret: 'x'.repeat(32) },
  phoneToken,
);
check(
  'a wrong connect secret is refused as not_trusted',
  badSecret.status === 404 && badSecret.json.error === 'not_trusted',
  `HTTP ${badSecret.status}`,
);

const noToken = await post('/connect/request', {
  desktopDeviceId: `desktop-${tag}`,
  mobileDeviceId: `mobile-${tag}`,
  pairSecret: approved.json.pairSecret,
});
check(
  'ringing without being the phone is refused',
  noToken.status === 404,
  `HTTP ${noToken.status}`,
);

// ── 8. Revocation ────────────────────────────────────────────────────────────
const laptopId = (list.json.devices ?? []).find((d) => d.kind === 'desktop')?.id;
const revoke = await req('DELETE', `/devices/${laptopId}`, undefined, phoneToken);
check('the phone revokes the laptop', revoke.status === 200, `HTTP ${revoke.status}`);

const afterRevoke = await post('/devices/token', await proof(laptop));
check(
  'a revoked laptop can no longer authenticate',
  afterRevoke.status === 403 && afterRevoke.json.error === 'device_revoked',
  `HTTP ${afterRevoke.status} ${afterRevoke.json.error}`,
);

const ringRevoked = await post(
  '/connect/request',
  {
    desktopDeviceId: `desktop-${tag}`,
    mobileDeviceId: `mobile-${tag}`,
    pairSecret: approved.json.pairSecret,
  },
  phoneToken,
);
check(
  'a revoked laptop cannot be rung, and says so honestly',
  // Not merely `!== 200`. It used to answer 503 `desktop_offline`, because
  // device revocation withdraws ownership while the `trusted_devices` row
  // survives as audit trail — so the pair authorized and the ring failed later,
  // at the presence check. Telling the owner their Mac is offline when it was
  // removed from the account is the one thing they would want to know.
  ringRevoked.status === 404 && ringRevoked.json.error === 'not_trusted',
  `HTTP ${ringRevoked.status} ${ringRevoked.json.error}`,
);

// The half this suite used to miss entirely. It checked that a revoked
// device's KEY stops working, then asserted that re-linking restores it — and
// the second assertion is right for a laptop, whose re-link needs the owner's
// phone to approve an enrollment code. Nothing checked the credential a thief
// actually holds.
//
// Revoking used to leave `refresh_tokens` untouched, so the account session on
// the stolen machine survived; an account session is enough to call
// `/devices/enroll`; and enrolling clears `revoked_at`. Verified against
// production in that order, all four steps succeeding.
const refreshAfterRevoke = await post('/auth/refresh', {
  refreshToken: login.json.refreshToken,
});
check(
  'revoking a device also ends the account sessions that could undo it',
  refreshAfterRevoke.status !== 200,
  `HTTP ${refreshAfterRevoke.status} — a 200 means the stolen machine can still refresh`,
);

const reLink = await post('/devices/enrollment-code', {
  ...(await proof(laptop)),
  fingerprint: `desktop-${tag}`,
  platform: 'macos',
});
const reApprove = await post(
  '/devices/enrollment-code/approve',
  { code: reLink.json.code },
  phoneToken,
);
const restored = await post('/devices/token', await proof(laptop));
check(
  're-linking a revoked laptop restores it',
  reApprove.status === 200 && restored.status === 200,
  `approve ${reApprove.status}, token ${restored.status}`,
);

// The other half, and the case with no second factor at all. A laptop is
// restored by a phone approving its code; a PHONE enrolls on an account token
// alone. So revoke the phone — using the laptop just restored above — and try
// exactly what a thief holding it would: re-enroll its own unchanged keypair
// with the account token it already had.
//
// `login.json.accessToken` was minted at sign-in, long before this revocation,
// which is the whole point. Enrolling clears `revoked_at`, so without the
// check this turns a ten-minute token lag into a permanently undone revoke.
const phoneId = (list.json.devices ?? []).find((d) => d.kind === 'mobile')?.id;
const revokePhone = await req(
  'DELETE',
  `/devices/${phoneId}`,
  undefined,
  restored.json.accessToken,
);
check(
  'the restored laptop revokes the phone',
  revokePhone.status === 200,
  `HTTP ${revokePhone.status}`,
);

const selfReEnroll = await post(
  '/devices/enroll',
  { ...(await proof(phone)), kind: 'mobile', fingerprint: `mobile-${tag}`, platform: 'ios' },
  login.json.accessToken,
);
check(
  'a credential older than the revocation cannot re-enroll the device',
  selfReEnroll.status === 403 && selfReEnroll.json.error === 'device_revoked',
  `HTTP ${selfReEnroll.status} ${selfReEnroll.json.error ?? ''} — a 200 means revocation can be undone by the device it revoked`,
);

// ── Deletion: the account, and everything it owns ───────────────────────────
//
// Last on purpose. It is both the cleanup and a real check: the audit fixture
// is the only account in existence whose whole life this script watched, so it
// is the only one that can prove the delete removed exactly what it claimed.
const wrongConfirmation = await req('DELETE', '/account', { confirmEmail: 'someone@else.test' },
  login.json.accessToken);
check(
  'deletion refuses a confirmation that names another account',
  wrongConfirmation.status === 400 && wrongConfirmation.json.error === 'confirmation_mismatch',
  `HTTP ${wrongConfirmation.status} ${wrongConfirmation.json.error ?? ''}`,
);

const unauthenticated = await req('DELETE', '/account', { confirmEmail: email });
check(
  'deletion refuses an unauthenticated caller',
  unauthenticated.status === 401,
  `HTTP ${unauthenticated.status}`,
);

const deleted = await req('DELETE', '/account', { confirmEmail: email }, login.json.accessToken);
check(
  'the account deletes itself, and says how many devices went with it',
  deleted.status === 200 && typeof deleted.json.devicesRemoved === 'number',
  `HTTP ${deleted.status} devicesRemoved=${deleted.json.devicesRemoved}`,
);

// The token is still syntactically valid — it was minted minutes ago and is
// signed, not stored. What must have changed is that the account behind it is
// gone, and every route that reads the database now says so.
const afterDelete = await req('GET', '/devices', undefined, restored.json.accessToken);
check(
  'a device token for a deleted account stops working immediately',
  afterDelete.status === 401,
  `HTTP ${afterDelete.status} — a 200 means deletion waits for a token to expire`,
);

const enrollAfterDelete = await post(
  '/devices/enroll',
  { ...(await proof(phone)), kind: 'mobile', fingerprint: `mobile-after-${tag}`, platform: 'ios' },
  login.json.accessToken,
);
check(
  'an account token for a deleted account cannot enroll a new device',
  enrollAfterDelete.status === 401,
  `HTTP ${enrollAfterDelete.status} — a 500 means the FK caught it instead of the gate`,
);

const signInAfterDelete = await post('/auth/password', { email, password });
check(
  'the deleted account cannot sign back in',
  signInAfterDelete.status === 401,
  `HTTP ${signInAfterDelete.status}`,
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

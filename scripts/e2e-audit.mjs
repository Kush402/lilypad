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
 * way out of a failure would destroy the state you wanted to look at. What it
 * does now is SAY so — naming the address it left and the statement that
 * removes it — because a boundary nobody is told about is a trap. One run
 * against production on 2026-08-23 died on a rate limit and orphaned an
 * account that was found by counting rows, not by reading this output.
 */
import { randomBytes, generateKeyPairSync, sign as nodeSign } from 'node:crypto';

// Keep running when stdout goes away.
//
// This script CREATES an account on the target — production, usually — and
// deletes it in its last three checks. Piping it to `head` closes the pipe,
// node raises EPIPE on the next write, and the run dies before those checks:
// two orphan `audit-…@example.test` accounts were left in the production
// database on 2026-08-25 that way, and had to be removed by hand. Swallowing
// EPIPE costs a truncated transcript and keeps the cleanup.
process.stdout.on('error', (err) => {
  if (err.code !== 'EPIPE') throw err;
});

const BASE = process.env.BASE ?? 'http://127.0.0.1:8099';
const PREFIX = 'lilypad-device-auth:v1:';
const b64u = (b) => Buffer.from(b).toString('base64url');
const tag = randomBytes(4).toString('hex');

let failures = 0;
/** Set by the signup and deletion checks, so the residue notice at the end is
 * accurate rather than a guess about how far the run got. Both are needed: a
 * run that 429s ON signup created nothing, and telling someone to delete an
 * account that was never made is the same kind of false statement this script
 * exists to catch. */
let createdAccount = false;
let deletedAccount = false;
// The second account, which exists for one check: a phone on another account
// may not pair with this laptop. Tracked separately so the residue notice at
// the end can name whichever of the two actually survived.
let createdStranger = false;
let deletedStranger = false;

/**
 * Fail on an unreachable target with a sentence instead of a stack trace.
 *
 * Without this the first `fetch` rejects and Node prints
 * `[TypeError: fetch failed] … ECONNREFUSED 127.0.0.1:8099`, which names the
 * default port rather than the mistake: this script reads `BASE`, and the
 * neighbouring `e2e-local.mjs` reads `LILYPAD_API`. Pointing it at production
 * with the wrong variable is the easiest error to make here and the least
 * legible one to read — it already cost one debugging round (L-32).
 */
async function requireReachable() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(15_000) });
    // A degraded backend still answers every route this script drives, so 503
    // is a reason to warn, not to refuse to run.
    if (res.status === 503) console.log(`note: ${BASE} reports degraded health; running anyway\n`);
    else if (!res.ok) throw new Error(`/health answered HTTP ${res.status}`);
  } catch (err) {
    console.error(`Cannot reach a Lilypad backend at ${BASE}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error('');
    console.error('This script targets the BASE environment variable:');
    console.error('  BASE=https://api.takedia.com node scripts/e2e-audit.mjs   # production');
    console.error('  BASE=http://127.0.0.1:8080  node scripts/e2e-audit.mjs   # a local backend');
    console.error('');
    console.error('(`scripts/e2e-local.mjs` is the one that reads LILYPAD_API.)');
    process.exit(1);
  }
}
await requireReachable();
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
const get = (p, t) => req('GET', p, undefined, t);

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

// ── 0. What this server says it can do ───────────────────────────────────────
//
// Both clients hide sign-in methods this answer marks unavailable, so a wrong
// answer here removes a way into the product for every user at once. Checked
// against production first, before anything else runs, because the rest of
// this script depends on the one method it reports nothing about — password —
// always being available.
const methods = await get('/auth/methods');
check(
  'the server publishes which ways in it can perform',
  methods.status === 200 && typeof methods.json.email === 'boolean',
  `HTTP ${methods.status} ${JSON.stringify(methods.json)}`,
);
check(
  'and it agrees with what the mail-dependent routes actually do',
  // Not a check that mail IS configured — that is an operator's decision. A
  // check that the ANSWER matches the behaviour: a server claiming it can send
  // mail while 503-ing every request to do so is the failure both clients
  // would render as two buttons that do nothing.
  methods.json.email ===
    ((await post('/auth/magic-link/request', { email: 'audit-methods@example.test' })).status !==
      503),
  `methods.email=${methods.json.email}`,
);

// ── 1. Signup + login ────────────────────────────────────────────────────────
const email = `audit-${tag}@example.test`;
const password = 'a-perfectly-ordinary-passphrase';
const signup = await post('/auth/signup', { name: 'Audit User', email, password });
createdAccount = signup.status === 201;
check('signup with name + email + password', signup.status === 201, `HTTP ${signup.status}`);
if (signup.status === 429) {
  // Naming the trap in the header was not enough — I walked into it twice on
  // 2026-08-23 running this back to back against production, read four
  // unrelated FAILs as regressions, and only found the cause by querying the
  // database. Signup is 5/minute per IP and the limit is shared, so a second
  // run inside the window fails on its first step and everything after it is
  // noise.
  console.log('\n429 on signup: the rate limiter, not a regression. Signup is 5/minute per IP.');
  console.log('Wait a minute and run this again. Nothing below this line means anything.\n');
}

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

// ── 3. The laptop joins the account by signing in on it (ADR-0015) ───────────
//
// This section asserted the OPPOSITE until 2026-08-25: a desktop was refused
// `403 desktop_enrollment_requires_approval` and could be owned only by a phone
// scanning its QR. The refusal withheld nothing — the capability behind it is a
// device token, and the same account password minted one right above with
// `kind: "mobile"` — while making ownership mean one thing on a phone and
// another on a Mac.
const laptop = newKey();
const laptopEnroll = await post(
  '/devices/enroll',
  {
    ...(await proof(laptop)),
    kind: 'desktop',
    fingerprint: `desktop-${tag}`,
    name: 'Audit MacBook',
    platform: 'macos',
  },
  login.json.accessToken,
);
check(
  'signing in on a computer is what puts it on the account',
  laptopEnroll.status === 200,
  `HTTP ${laptopEnroll.status} ${laptopEnroll.json.error ?? ''}`,
);
const laptopToken = laptopEnroll.json.accessToken;

check(
  'the token exchange names the wire id this computer is actually known by',
  laptopEnroll.json.fingerprint === `desktop-${tag}`,
  String(laptopEnroll.json.fingerprint),
);

// The repair for kanban L-153, end to end. `device_id` is a file in the app's
// data directory and the key is in the login keychain, so clearing one and not
// the other renames a computer without changing who it is. That used to answer
// `public_key_in_use` FOREVER — revocation leaves the row, so the key still
// resolved, and only deleting the keychain entry cleared it.
const drifted = await post(
  '/devices/enroll',
  {
    ...(await proof(laptop)),
    kind: 'desktop',
    fingerprint: `desktop-${tag}-wiped`,
    platform: 'macos',
  },
  login.json.accessToken,
);
check(
  'a computer that lost its local id is told what it is really called, not refused',
  drifted.status === 200 && drifted.json.fingerprint === `desktop-${tag}`,
  `HTTP ${drifted.status} ${drifted.json.error ?? drifted.json.fingerprint}`,
);

const stillOriginal = await post('/devices/token', await proof(laptop));
check(
  'and the wire id every pairing resolves through was NOT rewritten',
  stillOriginal.status === 200 && stillOriginal.json.fingerprint === `desktop-${tag}`,
  String(stillOriginal.json.fingerprint),
);

// One key naming both a laptop and a phone is not drift, and stays refused.
const crossKind = await post(
  '/devices/enroll',
  { ...(await proof(laptop)), kind: 'mobile', fingerprint: `mobile-${tag}-x`, platform: 'ios' },
  login.json.accessToken,
);
check(
  'one key may not name both a laptop and a phone',
  crossKind.status === 409 && crossKind.json.error === 'public_key_in_use',
  `HTTP ${crossKind.status} ${crossKind.json.error}`,
);

// ── 4. The enrollment QR still works, as the recovery path ───────────────────
//
// No longer the front door — signing in is (section 3) — but it is how a Mac
// whose sign-in enrollment failed, or that was removed from the account, gets
// back. A phone that is already on the account approves it.
const code = await post('/devices/enrollment-code', {
  ...(await proof(laptop)),
  fingerprint: `desktop-${tag}`,
  name: 'Audit MacBook',
  platform: 'macos',
});
check('laptop mints an enrollment code', code.status === 201, `HTTP ${code.status}`);
check('the code carries the address the PHONE should use', !!code.json.apiBaseUrl);

const approved = await post(
  '/devices/enrollment-code/approve',
  { code: code.json.code },
  phoneToken,
);
check('phone approves the code', approved.status === 200, `HTTP ${approved.status}`);
check('approval delivers the per-pair connect secret', !!approved.json.pairSecret);

const replay = await post('/devices/enrollment-code/approve', { code: code.json.code }, phoneToken);
check('the code is single-use', replay.status === 404, `HTTP ${replay.status}`);

// ── 5. Device management ─────────────────────────────────────────────────────
const list = await req('GET', '/devices', undefined, phoneToken);
const kinds = (list.json.devices ?? []).map((d) => `${d.kind}:${d.state}`).sort();
check(
  'both devices appear on the account, from signing in on each',
  list.status === 200 && kinds.join(',') === 'desktop:linked,mobile:linked',
  kinds.join(',') || `HTTP ${list.status}`,
);
check(
  'and the drifted enrollment did not leave a second row behind',
  (list.json.devices ?? []).filter((d) => d.kind === 'desktop').length === 1,
  `${(list.json.devices ?? []).filter((d) => d.kind === 'desktop').length} desktop rows`,
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

// ── 6b. A pair joins two devices on ONE account (ADR-0015) ───────────────────
//
// Previously unreachable from this ceremony — a Mac had no owner until a phone
// gave it one — and reachable the moment both machines started joining their
// own accounts independently. Without the guard, a laptop can end up listed in
// one account's "Your laptops" and no account's "Your devices": visible in one
// place, unmanageable from the other, revocable from neither.
const strangerEmail = `audit-stranger-${tag}@example.test`;
const strangerSignup = await post('/auth/signup', {
  name: 'Audit Stranger',
  email: strangerEmail,
  password,
});
createdStranger = strangerSignup.status === 201;
const strangerPhone = newKey();
const strangerEnroll = await post(
  '/devices/enroll',
  {
    ...(await proof(strangerPhone)),
    kind: 'mobile',
    fingerprint: `mobile-stranger-${tag}`,
    platform: 'ios',
  },
  strangerSignup.json.accessToken,
);

const strangerPairing = await post(
  '/pairing/create',
  { deviceId: `desktop-${tag}`, deviceName: 'Audit MacBook', platform: 'macos' },
  laptopToken,
);
const crossAccount = await post(
  '/pairing/redeem',
  {
    token: strangerPairing.json.token,
    deviceId: `mobile-stranger-${tag}`,
    platform: 'ios',
  },
  strangerEnroll.json.accessToken,
);
check(
  'a phone on another account cannot pair with this laptop',
  crossAccount.status === 403 && crossAccount.json.error === 'different_account',
  `HTTP ${crossAccount.status} ${crossAccount.json.error ?? ''}`,
);

const strangerGone = await req(
  'DELETE',
  '/account',
  { confirmEmail: strangerEmail },
  strangerSignup.json.accessToken,
);
deletedStranger = strangerGone.status === 200;
check(
  'the second account cleans itself up',
  strangerGone.status === 200,
  `HTTP ${strangerGone.status}`,
);

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
  {
    desktopDeviceId: `desktop-${tag}`,
    mobileDeviceId: `mobile-${tag}`,
    pairSecret: 'x'.repeat(32),
  },
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
  // Not merely `!== 200`, and the sentence has been wrong twice.
  //
  // It first answered 503 `desktop_offline`, because device revocation
  // withdraws ownership while the `trusted_devices` row survives as audit
  // trail — so the pair authorized and the ring failed later, at the presence
  // check, telling the owner their switched-on Mac was off. Then it answered
  // the anonymous 404 `not_trusted`, whose remedy is "pair again with a QR" —
  // advice that leads in a circle, because `/pairing/create` refuses a computer
  // no account owns.
  //
  // It now names the fact, because past `authorizeConnect` this caller has
  // proved it is the phone it names AND presented this laptop's per-pair
  // secret, so there is nothing left for the anonymous answer to protect.
  ringRevoked.status === 403 && ringRevoked.json.error === 'desktop_not_on_account',
  `HTTP ${ringRevoked.status} ${ringRevoked.json.error}`,
);

// …and the enumeration protection the reorder had to preserve. Same request,
// no token: a caller that could tell "removed from the account" from "no such
// pair" could walk the id space looking for real laptops.
const ringRevokedAnon = await post('/connect/request', {
  desktopDeviceId: `desktop-${tag}`,
  mobileDeviceId: `mobile-${tag}`,
  pairSecret: approved.json.pairSecret,
});
check(
  'an unproven caller learns nothing about that laptop',
  ringRevokedAnon.status === 404 && ringRevokedAnon.json.error === 'not_trusted',
  `HTTP ${ringRevokedAnon.status} ${ringRevokedAnon.json.error}`,
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

// The stale-credential guard, FIRST — while the laptop is still removed, which
// is the only state in which it means anything. Enrolling clears `revoked_at`,
// so a token minted before the removal must not be accepted: otherwise a
// stolen laptop undoes its own removal with the credential it was already
// holding, and the ten-minute access-token lifetime becomes a ten-minute
// window to reverse the one act that exists to stop it.
//
// Ordering matters and got this wrong once: run after the restore below, the
// row is no longer revoked and a 200 means nothing at all.
const staleToken = await post(
  '/devices/enroll',
  {
    ...(await proof(laptop)),
    kind: 'desktop',
    fingerprint: `desktop-${tag}`,
    platform: 'macos',
  },
  login.json.accessToken,
);
check(
  'a token minted before the removal cannot undo it',
  staleToken.status === 403 && staleToken.json.error === 'device_revoked',
  `HTTP ${staleToken.status} ${staleToken.json.error ?? ''} — a 200 means a stolen laptop can un-revoke itself`,
);

// And then the legitimate recovery: signing in again on the machine, which is
// what the message on it says. It needs a FRESH account session, which is
// exactly the distinction the check above rests on.
const freshLogin = await post('/auth/password', { email, password });
const reEnroll = await post(
  '/devices/enroll',
  {
    ...(await proof(laptop)),
    kind: 'desktop',
    fingerprint: `desktop-${tag}`,
    platform: 'macos',
  },
  freshLogin.json.accessToken,
);
const restored = await post('/devices/token', await proof(laptop));
check(
  'signing in again on a removed laptop restores it',
  reEnroll.status === 200 && restored.status === 200,
  `enroll ${reEnroll.status} ${reEnroll.json.error ?? ''}, token ${restored.status}`,
);

// ── Signing out ON the laptop ────────────────────────────────────────────────
//
// The path desktop sign-out actually takes, and the one nothing here covered:
// the laptop deletes its OWN row with its OWN device token. Everything above
// revoked the laptop from the phone, which reaches the same handler by a
// different authorization route — `manageDevice` has to admit a device
// managing itself, and "has to" was reasoning, not evidence.
//
// This is what makes the product's promise true: sign out, and a paired phone
// stops being able to reach the machine, then sign back in and it can again
// without a second QR.
const selfRelease = await req(
  'DELETE',
  `/devices/${laptopId}`,
  undefined,
  restored.json.accessToken,
);
check(
  'a laptop can take itself off the account — this is what Sign out does',
  selfRelease.status === 200,
  `HTTP ${selfRelease.status} ${selfRelease.json?.error ?? ''}`,
);

const afterSelfRelease = await post('/devices/token', await proof(laptop));
check(
  'and its key stops authenticating immediately',
  afterSelfRelease.status === 403 && afterSelfRelease.json.error === 'device_revoked',
  `HTTP ${afterSelfRelease.status} ${afterSelfRelease.json.error ?? ''}`,
);

// The reversible half. A fresh sign-in is what the confirmation on screen
// promises will bring the machine back, and the pair rows are untouched — so
// this must succeed without anybody scanning anything.
const backIn = await post('/auth/password', { email, password });
const reEnrollAfterSignOut = await post(
  '/devices/enroll',
  {
    ...(await proof(laptop)),
    kind: 'desktop',
    fingerprint: `desktop-${tag}`,
    platform: 'macos',
  },
  backIn.json.accessToken,
);
const pairsAfter = await req(
  'GET',
  `/devices/pairs?desktopDeviceId=desktop-${tag}`,
  undefined,
  reEnrollAfterSignOut.json.accessToken,
);
check(
  'signing back in restores it, pairings included — no second QR',
  reEnrollAfterSignOut.status === 200 &&
    pairsAfter.status === 200 &&
    (pairsAfter.json.pairs ?? []).some((p) => !p.revoked),
  `enroll ${reEnrollAfterSignOut.status}, pairs ${pairsAfter.status} live=${(pairsAfter.json?.pairs ?? []).filter((p) => !p.revoked).length}`,
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
// `reEnrollAfterSignOut`, not `restored`: the sign-out above revoked the token
// `restored` carries, so reusing it would answer 403 and be read as a failure
// of the phone-revoke rather than of the ordering.
const revokePhone = await req(
  'DELETE',
  `/devices/${phoneId}`,
  undefined,
  reEnrollAfterSignOut.json.accessToken,
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
const wrongConfirmation = await req(
  'DELETE',
  '/account',
  { confirmEmail: 'someone@else.test' },
  login.json.accessToken,
);
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
deletedAccount = deleted.status === 200;
check(
  'the account deletes itself, and says how many devices went with it',
  deleted.status === 200 && typeof deleted.json.devicesRemoved === 'number',
  `HTTP ${deleted.status} devicesRemoved=${deleted.json.devicesRemoved}`,
);

// The token is still syntactically valid — it was minted minutes ago and is
// signed, not stored. What must have changed is that the account behind it is
// gone, and every route that reads the database now says so.
//
// It must be a token that was LIVE right up to the deletion, or this proves
// nothing: `restored`'s token was revoked by the self-release above, so it
// would answer 401 for the wrong reason and pass whatever deletion did.
const afterDelete = await req(
  'GET',
  '/devices',
  undefined,
  reEnrollAfterSignOut.json.accessToken,
);
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

// What a failed run left behind, and how to remove it.
//
// The account is deliberately NOT force-deleted on the way out — the header
// says why: the state is what you came to look at. But leaving it unmentioned
// turns a deliberate boundary into a trap. A run against production on
// 2026-08-23 died on a rate limit and orphaned `audit-bc9a21b1@example.test`;
// it was found by counting rows, not by reading this output.
//
// `deletedAccount` is set by the deletion check itself, so this cannot claim
// residue that is not there, or miss residue that is.
if (createdStranger && !deletedStranger) {
  console.log(`\nThis run left a second account behind: ${strangerEmail}`);
  console.log('It exists only to prove a phone on another account cannot pair here.');
}
if (createdAccount && !deletedAccount) {
  console.log(`\nThis run left an account behind: ${email}`);
  console.log('It is not removed automatically — the state is what you came to look at.');
  console.log('When you are done, on the database host:');
  console.log(
    `  psql -U lilypad -d lilypad -c "DELETE FROM devices WHERE user_id=(SELECT id FROM users WHERE email='${email}'); DELETE FROM users WHERE email='${email}';"`,
  );
  console.log('  (devices and pairs cascade; audit rows keep their history with user_id NULL)');
}

process.exit(failures === 0 ? 0 : 1);

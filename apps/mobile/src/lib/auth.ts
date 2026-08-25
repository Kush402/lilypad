import { Platform } from 'react-native';
import {
  proofOriginOf,
  type DeviceSession,
  type DesktopEnrollmentApproved,
} from '@lilypad/protocol';
import { clearDeviceKey, devicePublicKey, signChallenge } from './identity';
import { clearDeviceId, deviceLabel, initDeviceIdentity } from './device';
import { forgetAllPairs } from './pairs';
import { APP_VERSION } from '../config/version';
import { loadSession } from './session';
import { UserFacingError } from './errors';

/**
 * This phone's authenticated relationship with the backend
 * ([ADR-0002](../../../../docs/adr/0002-device-identity.md)).
 *
 * Every backend call carries an access token minted from a signed challenge, so
 * the backend authorizes on the token's subject rather than on a device id the
 * request itself supplied.
 *
 * **Nothing bearer-shaped is persisted.** The access token lives in memory for
 * its ten minutes and is re-minted by re-signing a challenge; the only durable
 * credential on the phone is the private key in the Keychain. That is the whole
 * reason there is no device refresh token.
 */

const REQUEST_TIMEOUT_MS = 8_000;

/** Re-mint this far before the server would expire the token, so a token that
 * passes the check here cannot expire in flight. */
const RENEW_MARGIN_MS = 60_000;

interface CachedToken {
  value: string;
  renewAfter: number;
  /** Which backend minted it. A token is a credential for ONE server, and the
   * cache used to ignore this entirely — see `assertHomeBackend`. */
  apiBaseUrl: string;
}

let cached: CachedToken | null = null;
let inFlight: Promise<DeviceSession> | null = null;
/**
 * Set once the backend says this phone has no account behind it, so every
 * later call fails immediately instead of re-running a two-request exchange it
 * already knows the answer to.
 *
 * This matters because pairing now asks for a token on the way past
 * (`api.ts`), and most phones are un-enrolled until P1 lands the sign-in
 * screen — without the memo, every scan and every reconnect would pay for a
 * challenge and a rejection first. Cleared by `enrollDevice` and
 * `invalidateAccessToken`, so a phone that later signs in starts sending
 * tokens without needing a restart. A network failure is deliberately NOT
 * memoized: that is transient, and this is a verdict.
 */
let notEnrolled: DeviceAuthError | null = null;

/** The device is not allowed, and retrying with the same key never helps.
 * Distinct from a network error so the UI can send the user to sign-in instead
 * of into a retry loop. */
export class DeviceAuthError extends UserFacingError {
  constructor(readonly code: 'device_not_enrolled' | 'device_revoked') {
    super(
      code === 'device_revoked'
        ? 'This phone was removed from the account. Sign in to add it again.'
        : 'This phone is not signed in yet.',
    );
    this.name = 'DeviceAuthError';
  }
}

/**
 * Turn a 401 into the error whose remedy is already wired up.
 *
 * Every authenticated route can answer 401 for a reason that is about THIS
 * phone rather than the request: `requireAuth` for a token that no longer
 * verifies, and `rejectRevokedActor` for a device whose row was revoked or
 * whose account was deleted. Both mean the same thing to a person — the
 * credential in hand is finished, and signing in is what fixes it.
 *
 * Nothing used to say so. `invalidateAccessToken` below documents itself as
 * "called when the backend answers 401" and no such caller existed, so a 401
 * left the dead token cached for its full ten-minute TTL and surfaced as a raw
 * status code. Measured on production 2026-08-24: removing this phone from
 * "Your devices" — which the screen warns will sign it out — turned every
 * later action into `HTTP 401`, including `could not add that computer
 * (HTTP 401)` on the linking card, with no route back to sign-in.
 *
 * The body distinguishes the two, and both `DeviceAuthError` messages are
 * already the right sentence, so this adds no new copy.
 */
export function unauthorizedError(body: string): DeviceAuthError {
  invalidateAccessToken();
  return new DeviceAuthError(
    body.includes('device_revoked') ? 'device_revoked' : 'device_not_enrolled',
  );
}

/**
 * This phone's key already names a device on a DIFFERENT account.
 *
 * Separate from `DeviceAuthError` because the remedy is the opposite one.
 * `DeviceAuthError` means "sign in" — the same phone, on the account it
 * belongs to. This means the phone is the problem: no sign-in on this account
 * will ever succeed while it keeps this key, and the only way forward is
 * `resetDeviceIdentity()`.
 */
export class DeviceTakenError extends UserFacingError {
  constructor() {
    super(
      'This phone is already set up with a different Lilypad account. ' +
        'Sign in with that account, or start over on this phone as a new device.',
    );
    this.name = 'DeviceTakenError';
  }
}

/**
 * Give this phone a brand-new identity: new keypair, new id.
 *
 * The escape hatch from `DeviceTakenError`, and deliberately not automatic —
 * it abandons the device row on the old account (which keeps its pairings, and
 * can still be removed from "Your devices" there) and this phone loses every
 * pairing that row was on. Safe, though, in the way that matters: a new
 * keypair authenticates as nobody and inherits nothing.
 */
export async function resetDeviceIdentity(): Promise<void> {
  await clearDeviceKey();
  await clearDeviceId();
  // The stored pairs belong to the device row this phone just stopped being.
  // Their per-pair secrets can never authorise anything again, so leaving them
  // would only put dead laptops on "Your laptops" for the user to tap.
  await forgetAllPairs();
  resetAuthState();
}

/**
 * What to say when the device token exchange fails for a reason that is not
 * "this device is not allowed" — that case is `DeviceAuthError`, which has a
 * remedy of its own.
 *
 * One sentence about what happened, one about what to do. 429 is the status
 * worth separating: `/devices/challenge` and `/devices/token` are budgeted at
 * 60 a minute per address, and a shared network reaches that without anyone
 * doing anything unusual.
 */
function deviceExchangeFailure(status: number): string {
  if (status === 429) return 'Too many attempts just now. Wait a minute, then try again.';
  if (status === 400) return 'This version of Lilypad is too old for its server. Please update.';
  return 'Lilypad’s server isn’t responding properly. Try again in a moment.';
}

function endpoint(apiBaseUrl: string, path: string): string {
  return `${normalizeBase(apiBaseUrl)}${path}`;
}

/** One spelling per backend, so a trailing slash is not a different server. */
function normalizeBase(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/$/, '');
}

/**
 * Refuse to use this phone's device key against any backend but its own.
 *
 * A scanned QR names the backend the phone will talk to, and scanning is the
 * one thing this product has trained its users to do without thinking. Two
 * ways that turned into a credential handover, both fixed here:
 *
 * 1. **The cached token.** `cached` was a single slot that ignored the URL it
 *    was asked for, so `accessToken('https://evil.example')` returned the
 *    token minted for the real backend and `redeemToken` put it in an
 *    `Authorization` header aimed at the scanned host. One scan, no prompt,
 *    and a stranger holds a live device token: enough to list the account's
 *    laptops, and enough to approve an enrollment code and put a machine of
 *    their own on the account for good.
 *
 * 2. **Minting a fresh one there.** Keying the cache alone would not be
 *    enough. The proof is a signature over `DEVICE_AUTH_PREFIX + challenge`
 *    and nothing else — nothing in it names the server — so a host that can
 *    get this phone to sign a challenge can relay one from the real backend
 *    and replay the signature there. The remedy is not to sign at all.
 *
 * `DeviceAuthError` rather than a new type: the UI already routes it to
 * sign-in, which is exactly right. Signing in against the scanned backend is
 * the legitimate way to reach a second one (a self-hosted laptop), and
 * `ScannerScreen` already passes the scanned address along to that screen.
 */
async function assertHomeBackend(apiBaseUrl: string): Promise<void> {
  const session = await loadSession();
  if (session === null || normalizeBase(session.apiBaseUrl) !== normalizeBase(apiBaseUrl)) {
    throw new DeviceAuthError('device_not_enrolled');
  }
}

async function postJson(
  url: string,
  body: unknown,
  bearer?: string,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask for a nonce and sign it. Every authenticated exchange starts here. */
async function signedProof(apiBaseUrl: string): Promise<{
  challenge: string;
  publicKey: string;
  signature: string;
  appVersion: string;
  deviceName: string;
  proofOrigin?: string;
}> {
  const { status, text } = await postJson(endpoint(apiBaseUrl, '/devices/challenge'), {});
  // `SignInScreen` renders `err.message` verbatim, and this runs inside every
  // sign-in — so a backend having a bad minute used to put
  // `could not get a device challenge (HTTP 503)` on the first screen of the
  // product.
  if (status !== 201) throw new Error(deviceExchangeFailure(status));
  const { challenge } = JSON.parse(text) as { challenge: string };
  // The host this proof is FOR, signed along with the challenge (L-30). A
  // signature that names no server can be relayed to any other; one that names
  // `evil.example` is refused by the real backend.
  //
  // `null` when the address is not a parseable URL — then no `proofOrigin` is
  // sent and the v1 message is signed instead. Degrading is right here: an
  // unparseable base URL is a client bug, and refusing to sign at all would
  // turn it into a phone that cannot authenticate.
  const proofOrigin = proofOriginOf(apiBaseUrl);
  return {
    challenge,
    publicKey: await devicePublicKey(),
    signature: await signChallenge(challenge, proofOrigin),
    ...(proofOrigin ? { proofOrigin } : {}),
    // Rides along on every proof, which means every launch and every token
    // renewal — so `devices.app_version` is current without a heartbeat of its
    // own. Not part of what is signed: it is bookkeeping, and a signature over
    // it would only make an old client unable to talk to a new server.
    appVersion: APP_VERSION,
    // Rides along for the same reason, and heals the same defect: every phone
    // used to enroll as the literal "ios phone", so two of them on one account
    // were two identical rows. The server applies this only over that
    // placeholder, never over a name the user chose.
    deviceName: deviceLabel(),
  };
}

/**
 * Bind this phone to a signed-in account. Requires an ACCOUNT access token,
 * because enrollment is the moment the device gains an owner.
 */
export async function enrollDevice(
  apiBaseUrl: string,
  accountAccessToken: string,
): Promise<DeviceSession> {
  const proof = await signedProof(apiBaseUrl);
  const { status, text } = await postJson(
    endpoint(apiBaseUrl, '/devices/enroll'),
    {
      ...proof,
      kind: 'mobile',
      fingerprint: await initDeviceIdentity(),
      name: deviceLabel(),
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    },
    accountAccessToken,
  );
  // Not `throw new Error(\`... HTTP ${status}: ${text}\`)`. `SignInScreen`
  // renders `err.message` verbatim, so that put a raw status line and a JSON
  // body on the first screen of the product — and said nothing about the one
  // failure here that a person can actually act on.
  if (status === 409 && text.includes('device_owned_by_another_account')) {
    throw new DeviceTakenError();
  }
  if (status !== 200) {
    throw new Error(
      status === 409
        ? 'This phone could not be added to your account. Restart Lilypad and try again.'
        : 'Could not finish setting up this phone. Check your connection and try again.',
    );
  }
  const session = JSON.parse(text) as DeviceSession;
  notEnrolled = null;
  cache(session, apiBaseUrl);
  return session;
}

/**
 * Prove key possession and take a fresh device token — how the app
 * authenticates after a restart, with no user interaction.
 */
export async function signInDevice(apiBaseUrl: string): Promise<DeviceSession> {
  await assertHomeBackend(apiBaseUrl);
  const proof = await signedProof(apiBaseUrl);
  const { status, text } = await postJson(endpoint(apiBaseUrl, '/devices/token'), proof);
  if (status === 403) {
    notEnrolled = new DeviceAuthError(
      text.includes('device_revoked') ? 'device_revoked' : 'device_not_enrolled',
    );
    throw notEnrolled;
  }
  // Same reasoning, and the same reader: this reaches an Alert on the laptop
  // list by way of `toAppError`.
  if (status !== 200) throw new Error(deviceExchangeFailure(status));
  const session = JSON.parse(text) as DeviceSession;
  notEnrolled = null;
  cache(session, apiBaseUrl);
  return session;
}

/**
 * A valid access token, re-authenticating if the cached one is missing or close
 * to expiry.
 *
 * Concurrent callers share one exchange. Without that, a screen that fires
 * several requests at once would burn several challenges and race to overwrite
 * the cache with whichever finished last.
 */
export async function accessToken(apiBaseUrl: string): Promise<string> {
  const base = normalizeBase(apiBaseUrl);
  if (cached && cached.apiBaseUrl === base && Date.now() < cached.renewAfter) return cached.value;
  if (notEnrolled) throw notEnrolled;
  // Before the network, and before the shared exchange below: a foreign host
  // must not even be able to queue behind an in-flight one and take its token.
  await assertHomeBackend(base);
  inFlight ??= signInDevice(base).finally(() => {
    inFlight = null;
  });
  return (await inFlight).accessToken;
}

function cache(session: DeviceSession, apiBaseUrl: string): void {
  const ttlMs = session.expiresInSeconds * 1000;
  // A TTL at or below the margin would put `renewAfter` in the past and make
  // every call re-authenticate; keep a floor so short-TTL servers still cache.
  cached = {
    value: session.accessToken,
    renewAfter: Date.now() + Math.max(ttlMs - RENEW_MARGIN_MS, ttlMs / 2),
    apiBaseUrl: normalizeBase(apiBaseUrl),
  };
}

/**
 * Approve a desktop onto THIS phone's account
 * ([ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)).
 *
 * The laptop is identified entirely by the code — it was bound to the laptop's
 * public key when the code was minted, so nothing here can redirect the
 * enrollment to a different machine. The ACCOUNT it joins is the subject of
 * this phone's device token, never a value we send.
 */
export async function approveDesktopEnrollment(
  apiBaseUrl: string,
  code: string,
): Promise<DesktopEnrollmentApproved> {
  const { status, text } = await postJson(
    endpoint(apiBaseUrl, '/devices/enrollment-code/approve'),
    { code },
    await accessToken(apiBaseUrl),
  );
  // Before the generic branch below, which would render this as
  // `could not add that computer (HTTP 401)` — a dead end, when the phone
  // itself is what needs attention. `ScannerScreen` routes a `DeviceAuthError`
  // straight to sign-in and comes back to this same card.
  if (status === 401) throw unauthorizedError(text);
  if (status === 404) {
    throw new UserFacingError('That code has expired. Show a new one on the computer.');
  }
  if (status === 409) {
    throw new UserFacingError('That computer is already on another account.');
  }
  // `deviceExchangeFailure` rather than a status code: the remaining statuses
  // here are the same three it already words correctly — rate limited, a
  // client too old for its server, and a server having a bad minute. This is
  // the last place in the app that read a number aloud to a person.
  if (status !== 200) throw new Error(deviceExchangeFailure(status));
  return JSON.parse(text) as DesktopEnrollmentApproved;
}

/** Drop the cached token so the next call re-authenticates. Called when the
 * backend answers 401 — the token may have been revoked under us. */
export function invalidateAccessToken(): void {
  cached = null;
  notEnrolled = null;
}

/** Drop every cached token and verdict. A test seam, and the last step of
 * `resetDeviceIdentity` — a memoized `device_not_enrolled` from the old key
 * would otherwise reject the new one without asking. */
export function resetAuthState(): void {
  cached = null;
  inFlight = null;
  notEnrolled = null;
}

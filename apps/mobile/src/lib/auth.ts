import { Platform } from 'react-native';
import type { DeviceSession, DesktopEnrollmentApproved } from '@lilypad/protocol';
import { devicePublicKey, signChallenge } from './identity';
import { initDeviceIdentity } from './device';

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
}

let cached: CachedToken | null = null;
let inFlight: Promise<DeviceSession> | null = null;

/** The device is not allowed, and retrying with the same key never helps.
 * Distinct from a network error so the UI can send the user to sign-in instead
 * of into a retry loop. */
export class DeviceAuthError extends Error {
  constructor(readonly code: 'device_not_enrolled' | 'device_revoked') {
    super(
      code === 'device_revoked'
        ? 'This phone was removed from the account. Sign in to add it again.'
        : 'This phone is not signed in yet.',
    );
    this.name = 'DeviceAuthError';
  }
}

function endpoint(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}${path}`;
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
async function signedProof(
  apiBaseUrl: string,
): Promise<{ challenge: string; publicKey: string; signature: string }> {
  const { status, text } = await postJson(endpoint(apiBaseUrl, '/devices/challenge'), {});
  if (status !== 201) throw new Error(`could not get a device challenge (HTTP ${status})`);
  const { challenge } = JSON.parse(text) as { challenge: string };
  return {
    challenge,
    publicKey: await devicePublicKey(),
    signature: await signChallenge(challenge),
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
      name: `${Platform.OS} phone`,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    },
    accountAccessToken,
  );
  if (status !== 200) throw new Error(`enrollment failed (HTTP ${status}): ${text}`);
  const session = JSON.parse(text) as DeviceSession;
  cache(session);
  return session;
}

/**
 * Prove key possession and take a fresh device token — how the app
 * authenticates after a restart, with no user interaction.
 */
export async function signInDevice(apiBaseUrl: string): Promise<DeviceSession> {
  const proof = await signedProof(apiBaseUrl);
  const { status, text } = await postJson(endpoint(apiBaseUrl, '/devices/token'), proof);
  if (status === 403) {
    throw new DeviceAuthError(
      text.includes('device_revoked') ? 'device_revoked' : 'device_not_enrolled',
    );
  }
  if (status !== 200) throw new Error(`device sign-in failed (HTTP ${status}): ${text}`);
  const session = JSON.parse(text) as DeviceSession;
  cache(session);
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
  if (cached && Date.now() < cached.renewAfter) return cached.value;
  inFlight ??= signInDevice(apiBaseUrl).finally(() => {
    inFlight = null;
  });
  return (await inFlight).accessToken;
}

function cache(session: DeviceSession): void {
  const ttlMs = session.expiresInSeconds * 1000;
  // A TTL at or below the margin would put `renewAfter` in the past and make
  // every call re-authenticate; keep a floor so short-TTL servers still cache.
  cached = {
    value: session.accessToken,
    renewAfter: Date.now() + Math.max(ttlMs - RENEW_MARGIN_MS, ttlMs / 2),
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
  if (status === 404) {
    throw new Error('That code has expired. Show a new one on the computer.');
  }
  if (status === 409) {
    throw new Error('That computer is already on another account.');
  }
  if (status !== 200) throw new Error(`could not add that computer (HTTP ${status})`);
  return JSON.parse(text) as DesktopEnrollmentApproved;
}

/** Drop the cached token so the next call re-authenticates. Called when the
 * backend answers 401 — the token may have been revoked under us. */
export function invalidateAccessToken(): void {
  cached = null;
}

/** Test seam. */
export function resetAuthState(): void {
  cached = null;
  inFlight = null;
}

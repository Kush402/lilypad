import type {
  AccountDevice,
  AccountDeviceList,
  MobilePairListing,
  MobilePairListResponse,
} from '@lilypad/protocol';
import { accessToken, DeviceAuthError, unauthorizedError } from './auth';

/**
 * The account's own devices (P2).
 *
 * Deliberately a different list from `pairs.ts`, which holds the laptops THIS
 * phone has paired with, stored locally in the keychain. This one is the
 * account's — every machine it owns, from the backend — and revoking here is
 * strictly stronger than forgetting a pair: the device can no longer
 * authenticate at all
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
 *
 * Every call requires a device token, so an un-enrolled phone gets a
 * `DeviceAuthError` it can route to sign-in rather than an empty list — an
 * empty list would say "you own nothing", which is a different and false claim.
 */

const REQUEST_TIMEOUT_MS = 8_000;

export class AccountDeviceError extends Error {}

async function request(
  apiBaseUrl: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  const token = await accessToken(apiBaseUrl); // throws DeviceAuthError if not signed in
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        // ONLY when there is a body. Fastify rejects a request that declares
        // `application/json` and then sends nothing with
        // `FST_ERR_CTP_EMPTY_JSON_BODY`, before the route is even reached — so
        // a GET or DELETE that sets the header unconditionally fails with a
        // 400 that looks like the server refused the action. Caught by the
        // live end-to-end run, not by tests that mock `fetch`.
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    // A 401 is about this phone, not this request, so it must not reach the
    // callers below as `(HTTP 401)`. Revoking the device you are holding is a
    // supported act — the screen warns it signs you out — and this is what
    // makes the refresh that follows it land on sign-in instead of an error.
    if (res.status === 401) throw unauthorizedError(await res.text().catch(() => ''));
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Every device on this account. */
export async function listAccountDevices(apiBaseUrl: string): Promise<AccountDevice[]> {
  let res: Response;
  try {
    res = await request(apiBaseUrl, '/devices', { method: 'GET' });
  } catch (err) {
    if (err instanceof DeviceAuthError) throw err;
    throw new AccountDeviceError('Could not reach Lilypad. Check your connection.');
  }
  if (!res.ok) throw new AccountDeviceError(`Could not load your devices (HTTP ${res.status}).`);
  const body = (await res.json()) as AccountDeviceList;
  return body.devices;
}

/** Rename a device. The name is a label; nothing authorizes on it. */
export async function renameAccountDevice(
  apiBaseUrl: string,
  deviceId: string,
  name: string,
): Promise<void> {
  const res = await request(apiBaseUrl, `/devices/${deviceId}`, {
    method: 'PATCH',
    body: { name },
  });
  // 404 covers "not yours" and "no such device" alike, by design — the honest
  // message is the same either way and must not distinguish them.
  if (!res.ok) throw new AccountDeviceError('Could not rename that device.');
}

/**
 * Revoke a device: it can no longer authenticate, and the backend ends its
 * live sessions immediately rather than waiting out its access token.
 */
export async function revokeAccountDevice(apiBaseUrl: string, deviceId: string): Promise<void> {
  const res = await request(apiBaseUrl, `/devices/${deviceId}`, { method: 'DELETE' });
  if (!res.ok) throw new AccountDeviceError('Could not remove that device.');
}

/** A typed address that does not name this account. Its own type so the screen
 * can keep the form open and let the user fix a typo, rather than treating it
 * like a failure it can do nothing about. */
export class AccountDeleteConfirmationError extends AccountDeviceError {}

/**
 * Delete the account, permanently. Every device, every pairing, every session.
 *
 * The typed address is the confirmation, and it is the ONLY thing asked for —
 * unlike the Mac, which also asks for the password. The difference is not
 * inconsistency: the Mac deliberately stores no account credential, so it has
 * to re-authenticate to act as the account at all, while this phone is holding
 * a hardware-backed Ed25519 device key that already proves who it is. Asking
 * for a password here would also lock out every account that has never had one
 * — Apple, Google and magic-link sign-ins all reach this screen.
 */
export async function deleteAccount(apiBaseUrl: string, confirmEmail: string): Promise<void> {
  const res = await request(apiBaseUrl, '/account', {
    method: 'DELETE',
    body: { confirmEmail },
  });
  if (res.status === 400) {
    throw new AccountDeleteConfirmationError(
      'That is not the email address on this account. Type it exactly as you signed up.',
    );
  }
  if (!res.ok) throw new AccountDeviceError('Could not delete your account. Try again.');
}

/**
 * Every pair THIS phone holds, according to the backend
 * (`GET /devices/pairs/mine`).
 *
 * Distinct from `listAccountDevices` above: that answers "what does my account
 * own", this answers "which laptops may I still ring". A laptop can be on the
 * account and not paired with this particular phone.
 *
 * Throws rather than returning `[]` on any failure, because the caller uses
 * the result to DELETE local rows: an empty list from a failed request would
 * read as "you have no pairs" and wipe every laptop off the phone.
 */
export async function listMyPairs(apiBaseUrl: string): Promise<MobilePairListing[]> {
  let res: Response;
  try {
    res = await request(apiBaseUrl, '/devices/pairs/mine', { method: 'GET' });
  } catch (err) {
    if (err instanceof DeviceAuthError) throw err;
    throw new AccountDeviceError('Could not reach Lilypad. Check your connection.');
  }
  if (!res.ok) throw new AccountDeviceError(`Could not load your laptops (HTTP ${res.status}).`);
  const body = (await res.json()) as MobilePairListResponse;
  return body.pairs;
}

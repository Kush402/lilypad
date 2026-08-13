import type { AccountDevice, AccountDeviceList } from '@lilypad/protocol';
import { accessToken, DeviceAuthError } from './auth';

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
    return await fetch(`${apiBaseUrl.replace(/\/$/, '')}${path}`, {
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

import { Platform } from 'react-native';
import type { ConnectResponse, PairingRedeemResponse } from '@lilypad/protocol';
import { deviceLabel, initDeviceIdentity } from './device';
import { accessToken, DeviceAuthError, unauthorizedError } from './auth';
import { RedeemError, appError, classifyHttpStatus, classifyFetchError } from './errors';

/** Bounded so a slow/dead network surfaces as a classified, actionable error
 * instead of a spinner that never resolves. See
 * `docs/audit/m3/mobile-ux.md` Finding 2. */
const REDEEM_TIMEOUT_MS = 8_000;

/**
 * Headers proving WHICH phone this is (M9,
 * [ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)).
 *
 * **Throws `DeviceAuthError` when this phone is on no account**, and callers
 * are expected to route to sign-in rather than send the request anyway.
 *
 * This used to be best-effort: it swallowed the failure and sent no header,
 * because the backend applied a mirror-image rule and demanded a token only
 * for a device an account already owned. That lane is gone — the product model
 * is account → devices, so a phone on no account may not pair, connect or
 * unpair at all. Sending the request regardless would now earn a 404 that the
 * client cannot tell apart from "no such laptop", and the user would be shown
 * a dead end instead of the sign-in screen that actually fixes it.
 */
async function deviceAuthHeaders(apiBaseUrl: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await accessToken(apiBaseUrl)}` };
}

/** The best-effort variant, for the one call that must succeed offline. */
async function optionalDeviceAuthHeaders(apiBaseUrl: string): Promise<Record<string, string>> {
  try {
    return await deviceAuthHeaders(apiBaseUrl);
  } catch {
    return {};
  }
}

/**
 * Redeem a scanned pairing token against the backend. This burns the token
 * (single-use) and returns the signaling room the phone should join.
 *
 * `externalSignal`, when given, lets a caller actually cancel the in-flight
 * request (e.g. the user tapping Rescan) instead of merely ignoring its
 * eventual result — see `docs/audit/m3/mobile-ux.md` Finding 7.
 */
export async function redeemToken(
  apiBaseUrl: string,
  token: string,
  externalSignal?: AbortSignal,
): Promise<PairingRedeemResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REDEEM_TIMEOUT_MS);

  try {
    // The redeem is this identity's FIRST use in any session — awaiting the
    // keychain-backed init here (memoized; instant after app-start warmup)
    // guarantees every later sync getDeviceId() sees the persistent id.
    const deviceId = await initDeviceIdentity();
    // A cancel (Rescan tap, timeout) that landed during that await must not
    // fire the network request at all — and a fetch mock/polyfill handed an
    // already-aborted signal may never settle, so don't rely on fetch to
    // notice.
    if (controller.signal.aborted) {
      throw new RedeemError(classifyFetchError(timedOut));
    }
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/pairing/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await deviceAuthHeaders(apiBaseUrl)) },
      body: JSON.stringify({
        token,
        deviceId,
        deviceName: deviceLabel(),
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // `classifyHttpStatus` has no 401 branch, so this would land on
      // `unknown` — the least useful thing to say about the one failure with
      // an exact remedy. `ScannerScreen` already sends a `DeviceAuthError` to
      // sign-in and returns to this card.
      if (res.status === 401) throw unauthorizedError(text);
      throw new RedeemError(classifyHttpStatus(res.status, text));
    }
    return (await res.json()) as PairingRedeemResponse;
  } catch (err) {
    if (err instanceof RedeemError) throw err;
    // A phone with no account has a specific remedy — sign in — so it must
    // reach the caller as itself, not flattened into a network error.
    if (err instanceof DeviceAuthError) throw err;
    throw new RedeemError(classifyFetchError(timedOut));
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Ring a trusted desktop without a QR (M5.4, `POST /connect/request`). On
 * success the response mirrors a redeem, so the caller navigates into the
 * Viewer exactly like the scanner flow. Failures classify into the specific
 * trust codes (`not_trusted`/`trust_revoked`/`desktop_offline`) so the UI
 * can say the honest thing.
 */
export async function requestConnect(
  apiBaseUrl: string,
  desktopDeviceId: string,
  pairSecret?: string,
): Promise<ConnectResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REDEEM_TIMEOUT_MS);

  try {
    const mobileDeviceId = await initDeviceIdentity();
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/connect/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await deviceAuthHeaders(apiBaseUrl)) },
      body: JSON.stringify({
        desktopDeviceId,
        mobileDeviceId,
        mobileDeviceName: `${Platform.OS} phone`,
        ...(pairSecret ? { pairSecret } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // As in `redeemToken`: a revoked phone ringing a laptop is a 401
      // from `rejectRevokedActor`, and "something went wrong" is not what to
      // tell someone whose phone was removed from the account.
      if (res.status === 401) throw unauthorizedError(body);
      throw new RedeemError(classifyConnectStatus(res.status, body));
    }
    return (await res.json()) as ConnectResponse;
  } catch (err) {
    if (err instanceof RedeemError) throw err;
    if (err instanceof DeviceAuthError) throw err;
    throw new RedeemError(classifyFetchError(timedOut));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort mobile-initiated unpair (`POST /devices/unpair`, the mirror of
 * `requestConnect`). Called when the user "Forgets" a laptop: severs the trust
 * pairing on the backend too, so the laptop's Trusted Devices list stops
 * showing this phone — closing the asymmetry where a phone-side Forget left the
 * pairing alive on the laptop. Deliberately NEVER throws: forgetting must always
 * succeed locally even if the phone is offline or the stored backend address is
 * stale (the laptop can still revoke from its own side later, and a re-pair
 * un-revokes the row cleanly). Resolves to `true` if the backend acknowledged,
 * `false` otherwise — the caller may ignore the result.
 */
export async function requestUnpair(apiBaseUrl: string, desktopDeviceId: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDEEM_TIMEOUT_MS);
  try {
    const mobileDeviceId = await initDeviceIdentity();
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/devices/unpair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await optionalDeviceAuthHeaders(apiBaseUrl)),
      },
      body: JSON.stringify({ desktopDeviceId, mobileDeviceId }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false; // best-effort — offline / stale url / timeout all fine
  } finally {
    clearTimeout(timer);
  }
}

/** Map /connect/request failures onto the error taxonomy. The endpoint's
 * machine codes are authoritative where present; status is the fallback. */
function classifyConnectStatus(status: number, body: string) {
  if (status === 404 && body.includes('not_trusted')) return appError('not_trusted');
  if (status === 403 && body.includes('revoked')) return appError('trust_revoked');
  if (status === 503 && body.includes('desktop_offline')) return appError('desktop_offline');
  return classifyHttpStatus(status, body);
}
